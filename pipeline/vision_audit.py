#!/usr/bin/env python3
"""GuardRail vision audit: gemma4:26b judges the rendered page for what axe cannot see.

axe-core and the keyboard probe read the DOM.  This stage looks at pixels, for
the visual-only class of WCAG failures, and at the page's visual design:

=================  ==============================================================
check              what the model is shown (``scripts/vision-capture.js``)
=================  ==============================================================
contrast           crops of text axe could not decide (gradients, images,
                   overlays) - also measured from pixels: the same clip with the
                   text made transparent gives the real background
focus-visible      every Tab stop, unfocused beside focused (plus a pixel diff)
text-clipping      section crops at 1280px and 320px
color-only         section crops at 1280px
target-size        controls under 24 CSS px at 320px, with measured size/spacing
reflow             section crops at 320px (= 1280px at 400% zoom) plus measured
                   facts: horizontal overflow, controls that vanish at 320px
design review      section crops at 1280px plus the page's typography facts
=================  ==============================================================

Every judging call uses thinking and a JSON schema (``pipeline.vision_judge``);
calls run concurrently.  The model's boxes are grounded back onto real elements,
anything axe or the keyboard probe already flagged on that element is dropped
(``dedupe``), and every finding carries ``source: "vision"`` and a confidence
that combines the model's own estimate with the deterministic evidence.

A per-call cache keyed on the exact request (images, facts, prompt version,
model, sampling) lets an unchanged page reuse its judgement; a hit is recorded
as such, never presented as a fresh run.  ``regression_check`` is the pipeline's
``visual`` gate: pixel-identical regions pass without a model call; changed ones
are re-checked by the model with thinking off.

Usage:
  python3 pipeline/vision_audit.py [target] [--out DIR] [--known axe-report.json] [--fresh]
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from pipeline import vision_judge as judge  # noqa: E402

CAPTURE_SCRIPT = REPO_ROOT / "scripts" / "vision-capture.js"
CACHE_DIR = REPO_ROOT / "runtime" / "vision-cache"
PROMPT_VERSION = "guardrail-vision-4"
CAPTURE_TIMEOUT_S = 200
PARALLEL = max(1, int(os.environ.get("GUARDRAIL_VISION_PARALLEL", "3")))
MIN_CONFIDENCE = float(os.environ.get("GUARDRAIL_VISION_MIN_CONFIDENCE", "0.5"))
MAX_IMAGES_PER_CALL = 8
MODEL_IMAGE_MAX_SIDE = 1600
PIXEL_TOLERANCE = 24  # per-channel difference below this is treated as antialiasing noise
FOCUS_MIN_CHANGED_PX = 4
REGRESSION_MIN_CONFIDENCE = 0.5
MAX_REGRESSION_IMAGES = 10

WCAG = {
    "contrast": ("1.4.3", "Contrast (Minimum)", "wcag143", "wcag2aa",
                 "https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html"),
    "focus-visible": ("2.4.7", "Focus Visible", "wcag247", "wcag2aa",
                      "https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html"),
    "text-clipping": ("1.4.4", "Resize Text / Text Spacing", "wcag144", "wcag2aa",
                      "https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html"),
    "color-only": ("1.4.1", "Use of Color", "wcag141", "wcag2a",
                   "https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html"),
    "target-size": ("2.5.8", "Target Size (Minimum)", "wcag258", "wcag22aa",
                    "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html"),
    "reflow": ("1.4.10", "Reflow", "wcag1410", "wcag21aa",
               "https://www.w3.org/WAI/WCAG22/Understanding/reflow.html"),
}
DEFAULT_SEVERITY = {
    "contrast": "serious", "focus-visible": "serious", "text-clipping": "moderate",
    "color-only": "serious", "target-size": "moderate", "reflow": "serious",
}
# A vision finding of this category duplicates any of these DOM findings on the same element.
KNOWN_RULES_FOR = {
    "contrast": {"color-contrast", "color-contrast-enhanced", "link-in-text-block"},
    "focus-visible": set(),
    "text-clipping": set(),
    "color-only": {"link-in-text-block"},
    "target-size": {"target-size"},
    "reflow": {"meta-viewport", "meta-viewport-large", "css-orientation-lock"},
}
SEVERITY_ORDER = {"critical": 0, "serious": 1, "moderate": 2, "minor": 3}
CATEGORY_COLOURS = {
    "contrast": (230, 57, 70), "focus-visible": (255, 140, 0), "text-clipping": (155, 89, 182),
    "color-only": (0, 150, 136), "target-size": (33, 150, 243), "reflow": (214, 51, 132),
}

SYSTEM_PROMPT = """You are GuardRail's visual accessibility auditor. You see screenshots of a rendered web page.
axe-core has already checked the DOM (accessible names, labels, ARIA roles, alt text, computed CSS contrast):
never report those. Report only problems a sighted person can see in the pixels, and only when the image shows them.
Quote the element's visible text exactly as rendered, and give box_2d as [ymin, xmin, ymax, xmax] normalised
0-1000 relative to the image you cite, drawn tightly around the problem. confidence is your probability (0.0-1.0)
that this is a real WCAG failure. Do not pad the list: an image with no problem gets no finding.
Reason efficiently: note what matters in each image in a sentence or two, decide, and do not re-examine an image
you have already judged."""

CATEGORY_GUIDE = {
    "contrast": "contrast (WCAG 1.4.3/1.4.11): text or meaningful icons over photos, gradients or overlays that are "
                "hard to read. Normal text needs 4.5:1, large text (>=24px, or >=18.7px bold) 3:1.",
    "text-clipping": "text-clipping (1.4.4/1.4.12): text cut off or hidden by its container, words overlapping other "
                     "text or graphics, or letters so tightly spaced they collide and words are hard to read.",
    "color-only": "color-only (1.4.1): colour is the only visual cue for meaning, e.g. red/green status dots with no "
                  "icon or text, or links distinguishable from body text only by colour.",
    "target-size": "target-size (2.5.8): tappable controls smaller than 24x24 CSS px or crammed against each other.",
    "reflow": "reflow (1.4.10): at 320 CSS px, content or functionality disappears with no alternative (e.g. "
              "navigation hidden with no menu button), content needs horizontal scrolling, or content overlaps.",
}


class VisionCaptureError(RuntimeError):
    """The capture did not produce a usable record of the page."""


def log(stage: str, message: str) -> None:
    print(f"[{stage}] {message}", flush=True)


def rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


# --- capture ---------------------------------------------------------------------


def run_capture(target: Path | str, out_dir: Path, known_report: Path | None = None) -> dict:
    """Run scripts/vision-capture.js and return its validated capture.json."""
    args = ["node", str(CAPTURE_SCRIPT), str(target), "--out", str(out_dir)]
    if known_report is not None:
        args += ["--known", str(known_report)]
    try:
        process = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True, timeout=CAPTURE_TIMEOUT_S)
    except subprocess.TimeoutExpired as exc:
        raise VisionCaptureError(f"vision capture did not finish within {CAPTURE_TIMEOUT_S}s") from exc
    except OSError as exc:
        raise VisionCaptureError(f"could not start node: {exc}") from exc
    for line in (process.stdout or "").splitlines():
        if line.strip():
            log("vision:capture", line.strip())
    capture_file = out_dir / "capture.json"
    if process.returncode != 0 or not capture_file.exists():
        raise VisionCaptureError(
            f"vision capture exited {process.returncode}: {(process.stderr or '').strip()[-600:] or '(no stderr)'}"
        )
    try:
        capture = json.loads(capture_file.read_text())
    except json.JSONDecodeError as exc:
        raise VisionCaptureError(f"capture.json is not valid JSON: {exc}") from exc
    if not isinstance(target, str) or not re.match(r"^(https?|file)://", str(target)):
        expected = "file://" + str(Path(target).resolve())
        if capture.get("url") != expected:
            raise VisionCaptureError(f"capture describes {capture.get('url')!r}, not {expected!r}")
    for viewport in capture.get("viewports") or []:
        if not (out_dir / viewport["screenshot"]).exists():
            raise VisionCaptureError(f"capture is missing its {viewport['id']} screenshot")
    if len(capture.get("viewports") or []) != 2:
        raise VisionCaptureError("capture does not contain both the 1280px and 320px viewports")
    return capture


def viewport(capture: dict, viewport_id: str) -> dict:
    return next(v for v in capture["viewports"] if v["id"] == viewport_id)


# --- image helpers -----------------------------------------------------------------


def png_bytes(image: Image.Image, max_side: int = MODEL_IMAGE_MAX_SIDE) -> bytes:
    image = image.convert("RGB")
    longest = max(image.size)
    if longest > max_side:
        scale = max_side / longest
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def crop_css(image: Image.Image, rect: dict, scale: float, pad: float = 0) -> Image.Image:
    left = max(0, round((rect["x"] - pad) * scale))
    top = max(0, round((rect["y"] - pad) * scale))
    right = min(image.width, round((rect["x"] + rect["width"] + pad) * scale))
    bottom = min(image.height, round((rect["y"] + rect["height"] + pad) * scale))
    if right <= left or bottom <= top:
        return image.crop((0, 0, 1, 1))
    return image.crop((left, top, right, bottom))


def side_by_side(left: Image.Image, right: Image.Image, min_height: int = 180) -> Image.Image:
    gap = 16
    height = max(left.height, right.height)
    canvas = Image.new("RGB", (left.width + right.width + gap, height), (128, 128, 128))
    canvas.paste(left.convert("RGB"), (0, 0))
    canvas.paste(right.convert("RGB"), (left.width + gap, 0))
    if canvas.height < min_height:
        factor = min_height / canvas.height
        canvas = canvas.resize((round(canvas.width * factor), min_height), Image.LANCZOS)
    return canvas


def changed_pixels(a: Image.Image, b: Image.Image) -> tuple[int, tuple | None]:
    """Pixels whose largest channel difference exceeds PIXEL_TOLERANCE, and their bbox."""
    if a.size != b.size:
        return a.width * a.height, (0, 0, max(a.width, b.width), max(a.height, b.height))
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    mask = diff.convert("L").point(lambda value: 255 if value > PIXEL_TOLERANCE else 0)
    return sum(1 for value in mask.getdata() if value), mask.getbbox()


def parse_colour(value: str | None) -> tuple[float, float, float, float] | None:
    match = re.match(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)", value or "")
    if not match:
        return None
    alpha = match.group(4)
    a = 1.0 if alpha is None else (float(alpha[:-1]) / 100 if alpha.endswith("%") else float(alpha))
    return float(match.group(1)), float(match.group(2)), float(match.group(3)), a


def luminance(rgb: tuple[float, float, float]) -> float:
    def channel(c: float) -> float:
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def measure_contrast(background: Image.Image, text_rect: dict, colour: str | None, scale: float) -> dict | None:
    """Contrast of the text colour (alpha-blended) against the real pixels behind the glyph box."""
    fg = parse_colour(colour)
    if fg is None:
        return None
    box = crop_css(background, text_rect, scale).convert("RGB")
    pixels = list(box.getdata())
    if not pixels:
        return None
    stride = max(1, len(pixels) // 4000)
    ratios = []
    for bg in pixels[::stride]:
        blended = tuple(fg[3] * fg[i] + (1 - fg[3]) * bg[i] for i in range(3))
        ratios.append(contrast_ratio(blended, bg))
    ratios.sort()
    return {
        "median": round(median(ratios), 2),
        "p10": round(ratios[len(ratios) // 10], 2),
        "max": round(ratios[-1], 2),
        "samples": len(ratios),
        "text_colour": colour,
    }


def required_ratio(font_size_px: float | None, weight: str | int | None) -> float:
    try:
        numeric_weight = 700 if str(weight).lower() == "bold" else int(float(weight))
    except (TypeError, ValueError):
        numeric_weight = 400
    size = font_size_px or 16
    large = size >= 24 or (size >= 18.66 and numeric_weight >= 700)
    return 3.0 if large else 4.5


def font_px(value: Any) -> float | None:
    match = re.search(r"(-?[\d.]+)px", str(value or ""))
    return float(match.group(1)) if match else None


# --- grounding ---------------------------------------------------------------------


def norm_text(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()


def area(rect: dict) -> float:
    return max(0.0, rect["width"]) * max(0.0, rect["height"])


def intersection(a: dict, b: dict) -> float:
    w = min(a["x"] + a["width"], b["x"] + b["width"]) - max(a["x"], b["x"])
    h = min(a["y"] + a["height"], b["y"] + b["height"]) - max(a["y"], b["y"])
    return max(0.0, w) * max(0.0, h)


def box_to_rect(box: list, region_rect: dict) -> dict | None:
    """Gemma's [ymin, xmin, ymax, xmax] (0-1000, relative to the image) -> page CSS px."""
    if not isinstance(box, list) or len(box) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    if any(v < 0 or v > 1000 for v in (ymin, xmin, ymax, xmax)):
        return None
    ymin, ymax = sorted((ymin, ymax))
    xmin, xmax = sorted((xmin, xmax))
    if ymax - ymin < 1 or xmax - xmin < 1:
        return None
    return {
        "x": region_rect["x"] + xmin / 1000 * region_rect["width"],
        "y": region_rect["y"] + ymin / 1000 * region_rect["height"],
        "width": (xmax - xmin) / 1000 * region_rect["width"],
        "height": (ymax - ymin) / 1000 * region_rect["height"],
    }


STRUCTURAL_TAGS = {"section", "main", "header", "footer", "body", "article", "form", "nav", "div"}


def ground(rect: dict | None, elements: list[dict], visible_text: str = "") -> tuple[dict | None, str, float]:
    """The element a model box (and quoted text) refers to: (element, method, score)."""
    text = norm_text(visible_text)
    best, best_score = None, 0.0
    if rect is not None:
        for element in elements:
            overlap = intersection(rect, element["rect"])
            if overlap <= 0:
                continue
            union = area(rect) + area(element["rect"]) - overlap
            score = overlap / union if union else 0.0
            element_text = norm_text(element.get("text"))
            if len(text) >= 2 and element_text and (text in element_text or element_text in text):
                score += 0.5
            if element["tag"] in STRUCTURAL_TAGS and not element.get("own_text"):
                score -= 0.08
            if score > best_score:
                best, best_score = element, score
    if best is not None and best_score >= 0.15:
        return best, "box", round(best_score, 3)
    if len(text) >= 2:
        matches = [e for e in elements if text in norm_text(e.get("text")) and e.get("own_text")]
        if not matches:
            matches = [e for e in elements if text in norm_text(e.get("text"))]
        if matches:
            if rect is not None:
                cx, cy = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
                matches.sort(key=lambda e: (e["rect"]["x"] + e["rect"]["width"] / 2 - cx) ** 2
                             + (e["rect"]["y"] + e["rect"]["height"] / 2 - cy) ** 2)
            else:
                matches.sort(key=lambda e: area(e["rect"]))
            return matches[0], "text", 0.5
    return None, "region", 0.0


def snap_to_indicator(element: dict, rect: dict | None, elements: list[dict]) -> dict:
    """A colour-only finding is usually quoted by the text beside the indicator; prefer the
    small, textless element (a CSS status dot or icon) right next to that text."""
    anchor = rect if rect and area(rect) < 4 * max(1.0, area(element["rect"])) else element["rect"]
    ax, ay = anchor["x"] + anchor["width"] / 2, anchor["y"] + anchor["height"] / 2
    best, best_distance = element, 64.0
    for candidate in elements:
        r = candidate["rect"]
        if candidate.get("text") or candidate["interactive"] or max(r["width"], r["height"]) > 32:
            continue
        dx = max(r["x"] - (anchor["x"] + anchor["width"]), anchor["x"] - (r["x"] + r["width"]), 0)
        dy = max(r["y"] - (anchor["y"] + anchor["height"]), anchor["y"] - (r["y"] + r["height"]), 0)
        distance = (dx * dx + dy * dy) ** 0.5
        if distance < best_distance and abs(r["y"] + r["height"] / 2 - ay) < 40 and abs(r["x"] - ax) < 400:
            best, best_distance = candidate, distance
    return best


# --- task planning -----------------------------------------------------------------


def image_message(caption: str, image: Image.Image) -> dict:
    return {"role": "user", "content": caption, "images": [judge.encode_png(png_bytes(image))]}


def chunked(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)] or []


def spacing_exception(rect: dict, others: list[dict]) -> bool:
    """WCAG 2.5.8's spacing exception: a 24 CSS px circle centred on the undersized
    target intersects no other target, and no other undersized target's circle."""
    cx, cy = rect["x"] + rect["width"] / 2, rect["y"] + rect["height"] / 2
    for other in others:
        if other == rect:
            continue
        nearest_x = min(max(cx, other["x"]), other["x"] + other["width"])
        nearest_y = min(max(cy, other["y"]), other["y"] + other["height"])
        if (nearest_x - cx) ** 2 + (nearest_y - cy) ** 2 < 12 ** 2:
            return False
        if min(other["width"], other["height"]) < 24:
            ox, oy = other["x"] + other["width"] / 2, other["y"] + other["height"] / 2
            if (ox - cx) ** 2 + (oy - cy) ** 2 < 24 ** 2:
                return False
    return True


def typography_facts(elements: list[dict]) -> str:
    texts = [e for e in elements if e.get("own_text")]
    if not texts:
        return "No text elements were measured."
    smallest = sorted(texts, key=lambda e: e["font_size_px"])[:6]
    tight = []
    for e in texts:
        spacing = font_px(e.get("letter_spacing"))
        if spacing is not None and e["font_size_px"] and spacing / e["font_size_px"] <= -0.05:
            tight.append((spacing / e["font_size_px"], e))
    tight.sort(key=lambda pair: pair[0])
    lines = ["Smallest rendered text: " + "; ".join(
        f"{e['font_size_px']:.1f}px weight {e['font_weight']} '{e['own_text'][:40]}'" for e in smallest)]
    if tight:
        lines.append("Tightest letter-spacing: " + "; ".join(
            f"{ratio:+.3f}em on {e['font_size_px']:.0f}px '{e['own_text'][:30]}'" for ratio, e in tight[:5]))
    sizes = sorted({round(e["font_size_px"]) for e in texts})
    lines.append(f"Distinct font sizes (px): {sizes}")
    return "\n".join(lines)


def plan_tasks(capture: dict, cap_dir: Path) -> tuple[list[dict], dict]:
    """Build every model call from the capture; returns (tasks, context for interpretation)."""
    desktop, reflow = viewport(capture, "desktop"), viewport(capture, "reflow-320")
    shots = {vp["id"]: Image.open(cap_dir / vp["screenshot"]).convert("RGB") for vp in (desktop, reflow)}
    scale = {vp["id"]: vp["deviceScaleFactor"] for vp in (desktop, reflow)}
    crops_dir = cap_dir / "crops"
    crops_dir.mkdir(exist_ok=True)
    tasks: list[dict] = []
    context: dict[str, Any] = {"shots": shots, "scale": scale}

    def region_images(vp: dict) -> list[dict]:
        out = []
        for region in vp["regions"]:
            image = crop_css(shots[vp["id"]], region["rect"], scale[vp["id"]])
            name = f"region-{vp['id']}-{int(region['id']):02d}.png"
            image.save(crops_dir / name)
            out.append({"region": region, "image": image, "file": f"crops/{name}", "viewport": vp["id"]})
        return out

    desktop_regions, reflow_regions = region_images(desktop), region_images(reflow)

    def region_caption(n: int, item: dict, width: int) -> str:
        r = item["region"]
        part = f", part {r['chunk'] + 1} of {r['chunks']}" if r["chunks"] > 1 else ""
        return (f"Image {n}: page section {r['selector']}{part} rendered {width} CSS px wide "
                f"(page y {r['rect']['y']:.0f}-{r['rect']['y'] + r['rect']['height']:.0f} CSS px).")

    # 1. layout at 1280px: contrast over imagery, clipping/overlap, colour-only, targets
    for part, group in enumerate(chunked(desktop_regions, MAX_IMAGES_PER_CALL)):
        categories = ["contrast", "text-clipping", "color-only", "target-size"]
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages += [image_message(region_caption(i + 1, item, 1280), item["image"]) for i, item in enumerate(group)]
        messages.append({"role": "user", "content": (
            "These are consecutive sections of one page at a 1280 CSS px desktop width. Look for these problems only:\n- "
            + "\n- ".join(CATEGORY_GUIDE[c] for c in categories)
            + "\nFocus indicators and 320px reflow are judged separately; do not report them here.")})
        tasks.append({"name": f"layout-desktop-{part}", "kind": "findings", "think": True,
                      "schema": judge.FINDINGS_SCHEMA, "messages": messages, "categories": categories,
                      "images": group})

    # 2. reflow at 320px, with the measured facts
    facts = capture["reflow"]
    hidden = [h for h in facts["hidden_at_reflow"] if h.get("interactive")]
    measured = [f"Horizontal overflow at 320 CSS px: {facts['horizontal_overflow_px']} px."]
    if hidden:
        measured.append("Controls visible at 1280px but not rendered at all at 320px: "
                        + "; ".join(f"'{h['text']}' ({h['selector']})" for h in hidden[:12]) + ".")
    if facts["overflowing"]:
        measured.append("Elements extending past the 320px viewport: "
                        + "; ".join(f"'{o['text'][:30]}' ({o['selector']})" for o in facts["overflowing"][:10]) + ".")
    for part, group in enumerate(chunked(reflow_regions, MAX_IMAGES_PER_CALL)):
        categories = ["reflow", "text-clipping", "target-size"]
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages += [image_message(region_caption(i + 1, item, 320), item["image"]) for i, item in enumerate(group)]
        messages.append({"role": "user", "content": (
            "These are consecutive sections of the same page at 320 CSS px wide, which WCAG 1.4.10 treats as "
            "1280px zoomed to 400%. Measured by the browser, not guessed:\n" + "\n".join(measured)
            + "\nMissing content is a reflow failure you can see: if controls vanish at this width and no image shows "
              "a visible alternative that exposes them (a menu button with a menu icon or label), report category "
              "reflow on the image where they used to be, quoting the nearest visible text and boxing that area. "
              "Look for these problems only:\n- "
            + "\n- ".join(CATEGORY_GUIDE[c] for c in categories))})
        tasks.append({"name": f"reflow-320-{part}", "kind": "findings", "think": True,
                      "schema": judge.FINDINGS_SCHEMA, "messages": messages, "categories": categories,
                      "images": group, "measured": measured})

    # 3. focus visibility: unfocused | focused pairs
    focus_items = []
    for stop in capture["focus"]:
        if not stop.get("unfocused"):
            continue
        focused = Image.open(cap_dir / stop["focused"]).convert("RGB")
        unfocused = Image.open(cap_dir / stop["unfocused"]).convert("RGB")
        changed, bbox = changed_pixels(unfocused, focused)
        pair = side_by_side(unfocused, focused)
        name = f"focus-pair-{stop['index']:02d}.png"
        pair.save(crops_dir / name)
        focus_items.append({"stop": stop, "image": pair, "file": f"crops/{name}", "changed_px": changed,
                            "changed_ratio": round(changed / (focused.width * focused.height), 4), "bbox": bbox})
    context["focus_items"] = focus_items
    for part, group in enumerate(chunked(focus_items, 12)):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for i, item in enumerate(group):
            stop = item["stop"]
            label = stop["text"] or stop["tag"]
            messages.append(image_message(
                f"Image {i + 1}: keyboard focus stop {stop['index'] + 1} ('{label}', {stop['selector']}). "
                "LEFT half: the control unfocused. RIGHT half (after the grey bar): the same pixels after it "
                "received focus from a real Tab key press.", item["image"]))
        messages.append({"role": "user", "content": (
            "For every image, compare LEFT (unfocused) with RIGHT (focused). WCAG 2.4.7 requires a visible keyboard "
            "focus indicator: a sighted keyboard user must be able to tell which control has focus. A good indicator "
            "(2.4.13) is at least as thick as a 2 CSS px outline and has >=3:1 contrast against its surroundings. "
            "Describe what changed, if anything, then judge. Answer one item per image.")})
        tasks.append({"name": f"focus-{part}", "kind": "focus", "think": True, "schema": judge.FOCUS_SCHEMA,
                      "messages": messages, "images": group})

    # 4. contrast axe could not decide, measured from pixels as well
    contrast_items = []
    for index, candidate in enumerate(capture["contrast"]):
        if not candidate.get("rendered"):
            continue
        rendered = Image.open(cap_dir / candidate["rendered"]).convert("RGB")
        size_px = font_px(candidate.get("font_size")) or 16
        measurement = None
        if candidate.get("background"):
            background = Image.open(cap_dir / candidate["background"]).convert("RGB")
            measurement = measure_contrast(background, candidate["text_rect_in_clip"], candidate.get("color"),
                                           desktop["deviceScaleFactor"])
        contrast_items.append({
            "candidate": candidate, "image": rendered, "file": candidate["rendered"], "measured": measurement,
            "required": required_ratio(size_px, candidate.get("font_weight")), "font_px": size_px,
        })
    context["contrast_items"] = contrast_items
    if contrast_items:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for i, item in enumerate(contrast_items):
            c = item["candidate"]
            reason = c.get("axe_message") or c.get("why")
            messages.append(image_message(
                f"Image {i + 1}: text '{c['text']}' ({c['selector']}), {item['font_px']:.1f}px, weight "
                f"{c.get('font_weight')}, CSS colour {c.get('color')}. WCAG 1.4.3 requires {item['required']}:1 for this "
                f"text. axe-core could not decide: {reason}.", item["image"]))
        messages.append({"role": "user", "content": (
            "For every image, read the text, describe its colour and the colours directly behind the letters, "
            "estimate the contrast ratio between them (worst readable part), and say whether it meets the ratio "
            "required in its caption. Answer one item per image.")})
        tasks.append({"name": "contrast", "kind": "contrast", "think": True, "schema": judge.CONTRAST_SCHEMA,
                      "messages": messages, "images": contrast_items})

    # 5. touch targets under 24 CSS px at 320px
    target_items, target_exempt = [], []
    interactive_rects = [e["rect"] for e in reflow["elements"] if e["interactive"]]
    for candidate in capture["targets"]:
        if min(candidate["width"], candidate["height"]) >= 24:
            continue
        if spacing_exception(candidate["rect"], interactive_rects):
            target_exempt.append({k: candidate[k] for k in ("selector", "text", "width", "height")})
            continue
        image = crop_css(shots["reflow-320"], candidate["rect"], scale["reflow-320"], pad=28)
        name = f"target-{len(target_items):02d}.png"
        image.save(crops_dir / name)
        target_items.append({"candidate": candidate, "image": image, "file": f"crops/{name}"})
    context["target_items"] = target_items
    context["target_exempt"] = target_exempt
    if target_items:
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        for i, item in enumerate(target_items):
            c = item["candidate"]
            nearest = c.get("nearest") or {}
            messages.append(image_message(
                f"Image {i + 1}: control '{c['text'] or c['selector']}' ({c['selector']}) at 320 CSS px wide, "
                f"measured {c['width']}x{c['height']} CSS px; nearest other control's centre is "
                f"{nearest.get('distance', '?')} CSS px away. 1 CSS px = 2 image px.", item["image"]))
        messages.append({"role": "user", "content": (
            "WCAG 2.5.8 needs targets of at least 24x24 CSS px, unless a 24px circle centred on the target does not "
            "overlap another target or its circle (spacing exception); links inside a sentence are exempt. For every "
            "image, observe the control and its neighbours, then judge whether it is a real target-size problem for a "
            "touch user. Answer one item per image.")})
        tasks.append({"name": "targets", "kind": "targets", "think": True, "schema": judge.TARGETS_SCHEMA,
                      "messages": messages, "images": target_items})

    # 6. design review with an accessibility lens
    messages = [{"role": "system", "content": (
        "You are a senior product designer and accessibility specialist reviewing the visual design of a rendered "
        "web page. Your recommendations must make the page easier to read and use for people with low vision, "
        "colour-vision deficiency, dyslexia or motor impairments, while respecting the brand. Be concrete: name the "
        "element, give a CSS change. box_2d is [ymin, xmin, ymax, xmax] normalised 0-1000 relative to the image.")}]
    messages += [image_message(region_caption(i + 1, item, 1280), item["image"]) for i, item in enumerate(desktop_regions)]
    messages.append({"role": "user", "content": (
        "Measured typography from the browser:\n" + typography_facts(desktop["elements"])
        + "\n\nReview typography (font sizes, weights, letter-spacing, line-height), colour and contrast, spacing and "
          "density, visual hierarchy, layout and imagery. Score each 1-10 (10 = excellent). List real strengths, then "
          "up to 8 improvements ordered by accessibility impact, each tied to one image and element.")})
    tasks.append({"name": "design-review", "kind": "design", "think": True, "schema": judge.DESIGN_SCHEMA,
                  "messages": messages, "images": desktop_regions})
    return tasks, context


# --- running -----------------------------------------------------------------------


def task_key(task: dict, model_info: dict) -> str:
    payload = json.dumps({
        "prompt_version": PROMPT_VERSION, "model": model_info.get("model"),
        "model_modified_at": model_info.get("modified_at"), "sampling": judge.SAMPLING,
        "think": task["think"], "schema": task["schema"], "messages": task["messages"],
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def execute(task: dict, model_info: dict, tasks_dir: Path, use_cache: bool) -> dict:
    key = task_key(task, model_info)
    cached = CACHE_DIR / f"{key}.json"
    record: dict[str, Any] = {"name": task["name"], "think": task["think"], "images": len(task["images"]), "key": key}
    if use_cache and cached.exists():
        try:
            stored = json.loads(cached.read_text())
            record.update(status="ok", cached=True, cached_at=stored.get("created_at"),
                          cached_from=stored.get("run_dir"), stats=stored["result"]["stats"])
            (tasks_dir / f"{task['name']}.json").write_text(json.dumps({**stored, "cache_hit": True}, indent=2))
            return {**record, "result": stored["result"]}
        except (OSError, json.JSONDecodeError, KeyError):
            pass
    try:
        result = judge.chat(task["messages"], task["schema"], think=task["think"])
    except judge.VisionModelError as exc:
        return {**record, "status": "error", "cached": False, "error": str(exc)}
    stored = {"created_at": utc_now(), "run_dir": rel(tasks_dir.parent), "key": key, "result": result}
    (tasks_dir / f"{task['name']}.json").write_text(json.dumps(stored, indent=2))
    if use_cache:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(stored))
    return {**record, "status": "ok", "cached": False, "stats": result["stats"], "result": result}


# --- interpretation ------------------------------------------------------------------


def valid_image(item: dict, count: int) -> int | None:
    try:
        index = int(item.get("image"))
    except (TypeError, ValueError):
        return None
    return index - 1 if 1 <= index <= count else None


def make_finding(category: str, *, task: str, element: dict | None, rect: dict | None, viewport_id: str,
                 title: str, evidence: str, confidence: float, severity: str | None = None,
                 recommendation: str = "", method: str, image_file: str | None = None,
                 grounding: str = "exact", fallback_selector: str | None = None, extra: dict | None = None) -> dict:
    return {
        "category": category,
        "selector": element["selector"] if element else (fallback_selector or "(page)"),
        "element_text": (element or {}).get("text", ""),
        "html": (element or {}).get("html", ""),
        "known_rules": (element or {}).get("known_rules", []),
        "rect": rect or (element or {}).get("rect"),
        "viewport": viewport_id,
        "title": title.strip() or WCAG[category][1],
        "evidence": evidence.strip(),
        "recommendation": recommendation.strip(),
        "severity": severity if severity in SEVERITY_ORDER else DEFAULT_SEVERITY[category],
        "confidence": round(max(0.0, min(0.99, confidence)), 3),
        "method": method,
        "grounding": grounding,
        "tasks": [task],
        "image": image_file,
        **(extra or {}),
    }


def interpret(task: dict, result: dict, capture: dict, context: dict) -> tuple[list[dict], list[dict], dict | None]:
    """(findings, suppressed, design review) from one task's model output."""
    data = result["data"]
    findings: list[dict] = []
    suppressed: list[dict] = []

    if task["kind"] == "findings":
        vp_id = task["images"][0]["viewport"]
        elements = viewport(capture, vp_id)["elements"]
        for item in data.get("findings") or []:
            index = valid_image(item, len(task["images"]))
            category = item.get("category")
            if index is None or category not in WCAG:
                suppressed.append({"task": task["name"], "reason": "invalid image index or category", "item": item})
                continue
            if category not in task["categories"]:
                suppressed.append({"task": task["name"], "reason": f"{category} is judged by another pass", "item": item})
                continue
            region = task["images"][index]
            rect = box_to_rect(item.get("box_2d"), region["region"]["rect"])
            element, method, _score = ground(rect, elements, item.get("visible_text", ""))
            if category == "color-only" and element is not None:
                element, method = snap_to_indicator(element, rect, elements), method
            confidence = judge.normalise_confidence(item.get("confidence"))
            if element is None:
                confidence *= 0.8
            findings.append(make_finding(
                category, task=task["name"], element=element, rect=rect, viewport_id=vp_id,
                title=item.get("title", ""), evidence=item.get("evidence", ""), confidence=confidence,
                severity=item.get("severity"), recommendation=item.get("recommendation", ""), method="model",
                image_file=region["file"], grounding=method, fallback_selector=region["region"]["selector"],
                extra={"visible_text": item.get("visible_text", "")},
            ))

    elif task["kind"] == "focus":
        answers = {}
        for item in data.get("items") or []:
            index = valid_image(item, len(task["images"]))
            if index is not None:
                answers[index] = item
        elements = viewport(capture, "desktop")["elements"]
        by_selector = {e["selector"]: e for e in elements}
        for index, focus_item in enumerate(task["images"]):
            stop = focus_item["stop"]
            answer = answers.get(index)
            model_invisible = bool(answer) and answer.get("indicator_visible") is False
            model_confidence = judge.normalise_confidence((answer or {}).get("confidence"))
            no_pixels = focus_item["changed_px"] < FOCUS_MIN_CHANGED_PX
            deterministic = {"changed_px": focus_item["changed_px"], "changed_ratio": focus_item["changed_ratio"],
                             "focus_style": stop.get("focus_style"), "model_answer": answer}
            if no_pixels:
                confidence = max(0.95, model_confidence) if model_invisible else 0.9
                method = "pixel-diff+model" if model_invisible else "pixel-diff"
                evidence = (f"Tab moved focus to this control and not one pixel of its surroundings changed "
                            f"({focus_item['changed_px']} px differ). "
                            + (f"Model: {answer.get('change_seen')}" if answer else "Model gave no answer for it."))
            elif model_invisible:
                confidence, method = model_confidence, "model"
                evidence = (f"{focus_item['changed_px']} px changed on focus, but the model judged the indicator not "
                            f"visible enough ({answer.get('indicator_contrast')} contrast): {answer.get('change_seen')}")
            else:
                continue
            element = by_selector.get(stop["selector"]) or {
                "selector": stop["selector"], "text": stop["text"], "html": "", "known_rules": [], "rect": stop["rect"]}
            findings.append(make_finding(
                "focus-visible", task=task["name"], element=element, rect=stop["rect"], viewport_id="desktop",
                title=f"No visible focus indicator on '{stop['text'] or stop['tag']}'", evidence=evidence,
                confidence=confidence, recommendation=(
                    "Restore a focus style, e.g. `:focus-visible { outline: 3px solid currentColor; "
                    "outline-offset: 3px; }` and remove `outline: none`."),
                method=method, image_file=focus_item["file"], extra={"deterministic": deterministic},
            ))

    elif task["kind"] == "contrast":
        answers = {valid_image(i, len(task["images"])): i for i in data.get("items") or []}
        elements = viewport(capture, "desktop")["elements"]
        by_selector = {e["selector"]: e for e in elements}
        for index, contrast_item in enumerate(task["images"]):
            c = contrast_item["candidate"]
            answer = answers.get(index)
            measured = contrast_item["measured"]
            required = contrast_item["required"]
            model_fails = bool(answer) and (answer.get("passes") is False
                                            or (answer.get("estimated_ratio") or 99) < required)
            measured_fails = measured is not None and measured["median"] < required
            model_confidence = judge.normalise_confidence((answer or {}).get("confidence"))
            if model_fails and measured_fails:
                confidence, method = max(model_confidence, 0.9), "model+pixel-measurement"
            elif measured_fails:
                confidence, method = 0.75, "pixel-measurement"
            elif model_fails:
                confidence, method = model_confidence * (0.5 if measured is not None else 1.0), "model"
            else:
                continue
            parts = []
            if answer:
                parts.append(f"Model read '{answer.get('text_read')}', {answer.get('foreground')} on "
                             f"{answer.get('background')}, estimated {answer.get('estimated_ratio')}:1. "
                             f"{answer.get('evidence', '')}")
            if measured:
                parts.append(f"Measured from pixels: median {measured['median']}:1 (10th percentile {measured['p10']}:1) "
                             f"for {measured['text_colour']} over the real background; {required}:1 required.")
            element = by_selector.get(c["selector"]) or {
                "selector": c["selector"], "text": c["text"], "html": "", "known_rules": [], "rect": c["rect"]}
            findings.append(make_finding(
                "contrast", task=task["name"], element=element, rect=c["rect"], viewport_id="desktop",
                title=f"Low contrast text over {c.get('axe_reason') or 'a background image'}: '{c['text']}'",
                evidence=" ".join(parts), confidence=confidence, method=method, image_file=contrast_item["file"],
                recommendation="Give the text a solid backing (e.g. a dark scrim or badge background) or a darker "
                               f"colour so it reaches {required}:1 against every part of the background.",
                extra={"deterministic": {"measured": measured, "required": required,
                                         "axe_reason": c.get("axe_reason"), "model_answer": answer}},
            ))

    elif task["kind"] == "targets":
        answers = {valid_image(i, len(task["images"])): i for i in data.get("items") or []}
        elements = viewport(capture, "reflow-320")["elements"]
        by_selector = {e["selector"]: e for e in elements}
        for index, target_item in enumerate(task["images"]):
            answer = answers.get(index)
            if not answer or answer.get("is_problem") is not True:
                continue
            c = target_item["candidate"]
            element = by_selector.get(c["selector"])
            findings.append(make_finding(
                "target-size", task=task["name"], element=element, rect=c["rect"], viewport_id="reflow-320",
                title=f"Small touch target: '{c['text'] or c['selector']}' ({c['width']}x{c['height']} CSS px)",
                evidence=f"Measured {c['width']}x{c['height']} CSS px at 320px wide. {answer.get('observation', '')}",
                confidence=judge.normalise_confidence(answer.get("confidence")), method="model+measurement",
                image_file=target_item["file"], fallback_selector=c["selector"],
                recommendation="Increase the hit area to at least 24x24 CSS px (padding or min-height), or space "
                               "neighbouring targets apart.",
                extra={"deterministic": {"width": c["width"], "height": c["height"], "nearest": c.get("nearest")}},
            ))

    elif task["kind"] == "design":
        elements = viewport(capture, "desktop")["elements"]
        improvements = []
        for item in data.get("improvements") or []:
            index = valid_image(item, len(task["images"]))
            rect = box_to_rect(item.get("box_2d"), task["images"][index]["region"]["rect"]) if index is not None else None
            element, method, _ = ground(rect, elements, item.get("visible_text", ""))
            improvements.append({
                **{k: item.get(k) for k in ("area", "issue", "recommendation", "css_suggestion",
                                            "accessibility_benefit", "priority", "visible_text")},
                "selector": element["selector"] if element else None,
                "rect": rect, "grounding": method,
                "image": task["images"][index]["file"] if index is not None else None,
            })
        scores = {k: max(1, min(10, int(v))) for k, v in (data.get("scores") or {}).items()
                  if isinstance(v, (int, float))}
        return [], suppressed, {"summary": data.get("summary", ""), "strengths": data.get("strengths") or [],
                                "improvements": improvements, "scores": scores}
    return findings, suppressed, None


def dedupe(findings: list[dict], known: list[dict]) -> tuple[list[dict], list[dict]]:
    """Drop what axe/the keyboard probe already flagged; merge repeats across passes."""
    kept: dict[tuple, dict] = {}
    dropped: list[dict] = []
    for finding in findings:
        rules = KNOWN_RULES_FOR[finding["category"]]
        overlap = [k for k in finding["known_rules"] if k["rule"] in rules and k["relation"] in ("same", "inside")]
        if not overlap and finding["category"] == "contrast":
            overlap = [k for k in known if k.get("rule") == "color-contrast" and k.get("selector") == finding["selector"]]
        if overlap:
            dropped.append({"category": finding["category"], "selector": finding["selector"],
                            "duplicate_of": overlap[0], "reason": "already flagged by the DOM scan",
                            "confidence": finding["confidence"]})
            continue
        key = (finding["category"], finding["selector"])
        if key in kept:
            existing = kept[key]
            winner, loser = (finding, existing) if finding["confidence"] > existing["confidence"] else (existing, finding)
            winner = {**winner, "tasks": sorted(set(existing["tasks"]) | set(finding["tasks"])),
                      "confidence": round(min(0.99, winner["confidence"] + 0.05), 3),
                      "corroborating_evidence": [*winner.get("corroborating_evidence", []), loser["evidence"]]}
            dropped.append({"category": loser["category"], "selector": loser["selector"],
                            "reason": f"merged into the {winner['tasks']} finding", "confidence": loser["confidence"]})
            kept[key] = winner
        else:
            kept[key] = finding
    return list(kept.values()), dropped


# --- output ---------------------------------------------------------------------------


def font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def annotate(shot: Image.Image, scale: float, marks: list[tuple[int, dict, tuple]], out: Path, width: int) -> None:
    image = shot.copy()
    draw = ImageDraw.Draw(image)
    label_font = font(int(15 * scale))
    for number, rect, colour in marks:
        if not rect:
            continue
        box = [rect["x"] * scale - 4 * scale, rect["y"] * scale - 4 * scale,
               (rect["x"] + rect["width"]) * scale + 4 * scale, (rect["y"] + rect["height"]) * scale + 4 * scale]
        draw.rectangle(box, outline=colour, width=max(3, int(2.5 * scale)))
        text = str(number)
        tw = draw.textlength(text, font=label_font)
        lx, ly = box[0], max(0, box[1] - 20 * scale)
        draw.rectangle([lx, ly, lx + tw + 10 * scale, ly + 20 * scale], fill=colour)
        draw.text((lx + 5 * scale, ly + 2 * scale), text, fill=(255, 255, 255), font=label_font)
    factor = width / image.width
    image.resize((width, round(image.height * factor)), Image.LANCZOS).save(out, optimize=True)


def evidence_crop(shot: Image.Image, rect: dict | None, scale: float, out: Path) -> str | None:
    if not rect:
        return None
    crop_css(shot, rect, scale, pad=36).save(out)
    return out.name


def to_violation(finding: dict, source_file: str) -> dict:
    """The scans-collection entry: the agreed core keys plus vision provenance."""
    sc, name, tag, level, url = WCAG[finding["category"]]
    return {
        "rule_id": f"vision-{finding['category']}",
        "selector": finding["selector"],
        "severity": finding["severity"],
        "description": finding["title"],
        "source_file": source_file,
        "help": finding["recommendation"] or f"WCAG {sc} {name}",
        "help_url": url,
        "tags": [level, tag, "guardrail-vision"],
        "wcag_tags": [level, tag],
        "target": [finding["selector"]],
        "html": finding["html"],
        "failure_summary": finding["evidence"],
        "failed_checks": [],
        "scanner": f"ollama:{judge.MODEL}",
        "source": "vision",
        "confidence": finding["confidence"],
        "vision": {k: finding.get(k) for k in (
            "category", "viewport", "rect", "method", "grounding", "tasks", "evidence_image", "image",
            "element_text", "deterministic", "corroborating_evidence")},
    }


def audit_page(target: Path | str, out_dir: Path, *, known_report: Path | None = None, use_cache: bool = True,
               source_file: str | None = None) -> dict:
    """Capture, judge, ground, dedupe and write vision-report.json.  Raises VisionCaptureError
    only when the page could not be captured; model trouble is reported in the result."""
    started, clock = utc_now(), time.monotonic()
    out_dir.mkdir(parents=True, exist_ok=True)
    capture = run_capture(target, out_dir, known_report)
    source_file = source_file or capture["url"]
    report: dict[str, Any] = {
        "engine": {"name": "guardrail-vision", "prompt_version": PROMPT_VERSION},
        "url": capture["url"], "started_at": started, "artifacts_dir": rel(out_dir),
        "capture": {
            "capture_ms": capture["capture_ms"],
            "viewports": [{k: v[k] for k in ("id", "width", "page_height", "screenshot")} | {"regions": len(v["regions"])}
                          for v in capture["viewports"]],
            "focus_stops": len(capture["focus"]), "contrast_candidates": len(capture["contrast"]),
            "target_candidates": len(capture["targets"]), "reflow": {
                k: capture["reflow"][k] for k in ("horizontal_overflow_px", "hidden_at_reflow", "overflowing")},
        },
        "sampling": judge.SAMPLING,
    }

    try:
        model_info = judge.check_model()
    except judge.VisionModelError as exc:
        report.update(status="unavailable", error=f"vision model unavailable: {exc}", findings=[], violations=[],
                      tasks=[], finished_at=utc_now(), latency_s=round(time.monotonic() - clock, 2))
        (out_dir / "vision-report.json").write_text(json.dumps(report, indent=2))
        return report
    report["model"] = model_info
    try:
        released = judge.make_room(model_info["num_ctx"])
    except judge.VisionModelError as exc:
        released = [f"(could not unload a mismatched runner: {exc})"]
    if released:
        log("vision", f"unloaded runner(s) at a different context that would block {model_info['model']}: "
                      + ", ".join(released))

    tasks, context = plan_tasks(capture, out_dir)
    tasks_dir = out_dir / "tasks"
    tasks_dir.mkdir(exist_ok=True)
    log("vision", f"{len(tasks)} judging call(s) to {model_info['model']} (num_ctx {model_info['num_ctx']}, "
                  f"thinking on, {PARALLEL} in parallel, cache {'on' if use_cache else 'off'})")
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        runs = list(pool.map(lambda t: execute(t, model_info, tasks_dir, use_cache), tasks))

    findings, suppressed, design = [], [], None
    task_records = []
    for task, run in zip(tasks, runs):
        task_records.append({k: run.get(k) for k in ("name", "think", "images", "status", "cached", "cached_at",
                                                     "cached_from", "stats", "error")})
        if run["status"] != "ok":
            log("vision", f"{task['name']}: FAILED - {run['error']}")
            continue
        stats = run["stats"]
        log("vision", f"{task['name']}: {len(task['images'])} image(s), "
                      + ("CACHED (identical request judged " + str(run.get("cached_at")) + ")" if run["cached"]
                         else f"{stats['latency_s']}s, {stats['output_tokens']} tokens"))
        try:
            task_findings, task_suppressed, task_design = interpret(task, run["result"], capture, context)
        except (KeyError, TypeError, ValueError) as exc:
            task_records[-1].update(status="error", error=f"model answer could not be interpreted: {exc}")
            log("vision", f"{task['name']}: answer not interpretable - {exc}")
            continue
        findings += task_findings
        suppressed += task_suppressed
        design = task_design or design

    known = capture.get("known") or []
    merged, dropped = dedupe(findings, known)
    confident = [f for f in merged if f["confidence"] >= MIN_CONFIDENCE]
    suppressed += [{"category": f["category"], "selector": f["selector"], "confidence": f["confidence"],
                    "reason": f"confidence below {MIN_CONFIDENCE}", "title": f["title"]}
                   for f in merged if f["confidence"] < MIN_CONFIDENCE]
    confident.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], -f["confidence"]))

    evidence_dir = out_dir / "evidence"
    evidence_dir.mkdir(exist_ok=True)
    shots, scale = context["shots"], context["scale"]
    for number, finding in enumerate(confident, start=1):
        finding["number"] = number
        finding["evidence_image"] = f"evidence/{evidence_crop(shots[finding['viewport']], finding['rect'], scale[finding['viewport']], evidence_dir / f'finding-{number:02d}.png')}"
    annotated = {}
    for vp_id, width in (("desktop", 1280), ("reflow-320", 480)):
        marks = [(f["number"], f["rect"], CATEGORY_COLOURS[f["category"]]) for f in confident if f["viewport"] == vp_id]
        name = f"annotated-{vp_id}.png"
        annotate(shots[vp_id], scale[vp_id], marks, out_dir / name, width)
        annotated[vp_id] = name
    if design:
        for number, item in enumerate(design["improvements"], start=1):
            item["number"] = number
        annotate(shots["desktop"], scale["desktop"],
                 [(i["number"], i["rect"], (37, 99, 235)) for i in design["improvements"]],
                 out_dir / "annotated-design.png", 1280)
        annotated["design"] = "annotated-design.png"
        scores = design["scores"]
        design["overall_score"] = scores.get("overall")

    failed_tasks = [r["name"] for r in task_records if r["status"] != "ok"]
    status = "complete" if not failed_tasks else ("unavailable" if len(failed_tasks) == len(task_records) else "partial")
    cached_count = sum(1 for r in task_records if r.get("cached"))
    report.update(
        status=status,
        error=(f"judging call(s) did not complete: {', '.join(failed_tasks)}" if failed_tasks else None),
        tasks=task_records,
        cache={"enabled": use_cache, "hits": cached_count, "calls": len(task_records),
               "all_cached": cached_count == len(task_records) and bool(task_records)},
        findings=confident,
        suppressed=suppressed,
        deduplicated=dropped,
        design_review=design,
        target_spacing_exempt=context.get("target_exempt", []),
        annotated=annotated,
        counts={"findings": len(confident), "by_category": {c: sum(1 for f in confident if f["category"] == c)
                                                           for c in WCAG},
                "suppressed": len(suppressed), "deduplicated": len(dropped)},
        finished_at=utc_now(),
        latency_s=round(time.monotonic() - clock, 2),
    )
    report["violations"] = [to_violation(f, source_file) for f in confident]
    (out_dir / "vision-report.json").write_text(json.dumps(report, indent=2))
    return report


def scan_summary(report: dict) -> dict:
    """What the scans document keeps (``vision_audit``): no thinking traces, no per-task payloads."""
    keep = ("status", "error", "engine", "model", "sampling", "started_at", "finished_at", "latency_s",
            "artifacts_dir", "capture", "tasks", "cache", "counts", "design_review", "annotated", "deduplicated")
    summary = {k: report.get(k) for k in keep if k in report}
    summary["suppressed"] = [
        {k: s.get(k) for k in ("category", "selector", "confidence", "reason", "title")} for s in report.get("suppressed", [])
    ]
    return summary


# --- regression re-check (the pipeline's visual gate) ------------------------------------


def regression_check(baseline_dir: Path, verify_dir: Path, out_dir: Path) -> dict:
    """Compare the patched page's capture with the baseline's.

    Pixel-identical regions and focus stops pass without a model call.  Changed
    ones are cropped to the change and re-checked by the model (thinking off).
    Measured regressions (new horizontal overflow, controls lost at 320px, focus
    stops lost) fail the gate on their own.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    base = json.loads((baseline_dir / "capture.json").read_text())
    after = json.loads((verify_dir / "capture.json").read_text())
    compared, changes, measured = 0, [], []

    for vp_id in ("desktop", "reflow-320"):
        b_vp, a_vp = viewport(base, vp_id), viewport(after, vp_id)
        b_shot = Image.open(baseline_dir / b_vp["screenshot"]).convert("RGB")
        a_shot = Image.open(verify_dir / a_vp["screenshot"]).convert("RGB")
        scale = b_vp["deviceScaleFactor"]
        b_regions = {(r["selector"], r["chunk"]): r for r in b_vp["regions"]}
        a_regions = {(r["selector"], r["chunk"]): r for r in a_vp["regions"]}
        for key in sorted(set(b_regions) | set(a_regions)):
            compared += 1
            b_r, a_r = b_regions.get(key), a_regions.get(key)
            if b_r is None or a_r is None:
                present = a_r or b_r
                image = crop_css(a_shot if a_r else b_shot, present["rect"], scale)
                changes.append({"kind": "region-added" if a_r else "region-removed", "viewport": vp_id,
                                "selector": key[0], "before": None if a_r else image, "after": image if a_r else None})
                continue
            b_img, a_img = crop_css(b_shot, b_r["rect"], scale), crop_css(a_shot, a_r["rect"], scale)
            count, bbox = changed_pixels(b_img, a_img)
            if count == 0:
                continue
            if b_img.size == a_img.size and bbox:
                pad = 40 * scale
                roi = (max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                       min(b_img.width, bbox[2] + pad), min(b_img.height, bbox[3] + pad))
                b_img, a_img = b_img.crop(roi), a_img.crop(roi)
            changes.append({"kind": "region-changed", "viewport": vp_id, "selector": key[0],
                            "changed_px": count, "before": b_img, "after": a_img})

    b_focus = {s["selector"]: s for s in base["focus"]}
    a_focus = {s["selector"]: s for s in after["focus"]}
    for selector, stop in b_focus.items():
        compared += 1
        if selector not in a_focus:
            measured.append(f"focus stop lost: {selector} ('{stop['text']}') is no longer reached by Tab")
            continue
        b_img = Image.open(baseline_dir / stop["focused"]).convert("RGB")
        a_img = Image.open(verify_dir / a_focus[selector]["focused"]).convert("RGB")
        count, _ = changed_pixels(b_img, a_img)
        if count:
            changes.append({"kind": "focus-changed", "viewport": "desktop", "selector": selector,
                            "changed_px": count, "before": b_img, "after": a_img})

    b_reflow, a_reflow = base["reflow"], after["reflow"]
    if a_reflow["horizontal_overflow_px"] > b_reflow["horizontal_overflow_px"]:
        measured.append(f"horizontal overflow at 320px grew from {b_reflow['horizontal_overflow_px']}px "
                        f"to {a_reflow['horizontal_overflow_px']}px")
    lost = sorted({h["selector"] for h in a_reflow["hidden_at_reflow"]} - {h["selector"] for h in b_reflow["hidden_at_reflow"]})
    if lost:
        measured.append(f"newly hidden at 320px: {', '.join(lost)}")

    record: dict[str, Any] = {
        "compared": compared, "changed": len(changes), "measured_regressions": measured, "model_called": False,
        "changes": [{k: c.get(k) for k in ("kind", "viewport", "selector", "changed_px")} for c in changes],
    }
    if measured:
        record.update(status="failed", reason="; ".join(measured))
    if not changes:
        record.setdefault("status", "passed")
        record.setdefault("reason", f"all {compared} regions and focus stops are pixel-identical to the baseline")
        (out_dir / "visual-gate.json").write_text(json.dumps(record, indent=2))
        return record

    judged = changes[:MAX_REGRESSION_IMAGES]
    blank = Image.new("RGB", (200, 120), (255, 255, 255))
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for i, change in enumerate(judged):
        pair = side_by_side(change["before"] or blank, change["after"] or blank)
        name = f"regression-{i:02d}.png"
        pair.save(out_dir / name)
        change["file"] = name
        messages.append(image_message(
            f"Image {i + 1}: {change['kind']} in {change['selector']} at {change['viewport']}. LEFT: before the patch. "
            "RIGHT (after the grey bar): after the patch. A white panel means the region did not exist.", pair))
    messages.append({"role": "user", "content": (
        "A code patch changed these parts of the page. For every image say what changed, and whether the RIGHT side "
        "introduces a visual accessibility regression: lower text contrast, a lost or weaker focus indicator, "
        "clipped/overlapping text, colour-only meaning, smaller targets, or broken layout. A change that keeps the page "
        "as readable and usable is not a regression. Answer one item per image.")})
    record["model_called"] = True
    record["unjudged_changes"] = max(0, len(changes) - len(judged))
    try:
        judge.make_room(judge.check_model()["num_ctx"])
        result = judge.chat(messages, judge.REGRESSION_SCHEMA, think=False, timeout=judge.RECHECK_TIMEOUT_S)
    except judge.VisionModelError as exc:
        record.setdefault("status", "unavailable")
        record["error"] = f"{len(changes)} region(s) changed and the model re-check could not run: {exc}"
        (out_dir / "visual-gate.json").write_text(json.dumps(record, indent=2))
        return record
    (out_dir / "visual-gate-model.json").write_text(json.dumps(result, indent=2))
    regressions = []
    answers = {valid_image(item, len(judged)): item for item in result["data"].get("items") or []}
    for index, change in enumerate(judged):
        answer = answers.get(index)
        if answer is None:
            regressions.append({"selector": change["selector"], "reason": "model gave no verdict for this change"})
            continue
        confidence = judge.normalise_confidence(answer.get("confidence"))
        if answer.get("regression") is True and confidence >= REGRESSION_MIN_CONFIDENCE:
            regressions.append({"selector": change["selector"], "category": answer.get("category"),
                                "what_changed": answer.get("what_changed"), "confidence": confidence,
                                "image": change["file"]})
    record["model"] = {"name": judge.MODEL, "think": False, **result["stats"]}
    record["verdicts"] = [answers.get(i) for i in range(len(judged))]
    record["regressions"] = regressions
    if record["unjudged_changes"]:
        regressions.append({"reason": f"{record['unjudged_changes']} changed region(s) exceeded the re-check limit"})
    if "status" not in record:
        record["status"] = "failed" if regressions else "passed"
        record["reason"] = (f"{len(regressions)} visual regression(s)" if regressions
                            else f"{len(changes)} changed region(s) re-checked by the model: no regression")
    (out_dir / "visual-gate.json").write_text(json.dumps(record, indent=2))
    return record


# --- CLI -------------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("target", nargs="?", default=str(REPO_ROOT / "demo" / "index.html"))
    parser.add_argument("--out", help="artifact directory (default: pipeline/runs/vision-<timestamp>)")
    parser.add_argument("--known", help="axe-shaped report whose findings vision must not duplicate "
                                        "(default: run the axe scan first)")
    parser.add_argument("--fresh", action="store_true", help="ignore the judgement cache")
    args = parser.parse_args()

    out = Path(args.out) if args.out else REPO_ROOT / "pipeline" / "runs" / f"vision-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}"
    out.mkdir(parents=True, exist_ok=True)
    known = Path(args.known) if args.known else None
    if known is None and not re.match(r"^https?://", args.target):
        scanner = subprocess.run(["node", str(REPO_ROOT / "scripts" / "a11y-scan.js"), args.target],
                                 cwd=REPO_ROOT, capture_output=True, text=True, timeout=120)
        report = REPO_ROOT / "reports" / "a11y-report.json"
        if scanner.returncode in (0, 1) and report.exists():
            known = out / "axe-known.json"
            shutil.copy(report, known)
            log("vision", f"axe scan for dedupe: exit {scanner.returncode}, copied to {rel(known)}")
    try:
        report = audit_page(args.target, out, known_report=known, use_cache=not args.fresh)
    except VisionCaptureError as exc:
        print(f"VISION AUDIT FAILED: {exc}", file=sys.stderr)
        return 2
    print()
    log("vision", f"status={report['status']} findings={len(report['findings'])} latency={report['latency_s']}s")
    for f in report["findings"]:
        log("vision", f"  #{f['number']} [{f['severity']}] vision-{f['category']} {f['selector']} "
                      f"conf={f['confidence']} ({f['method']}): {f['title']}")
    for d in report.get("deduplicated", []):
        log("vision", f"  deduplicated: {d['category']} {d['selector']} - {d['reason']}")
    design = report.get("design_review")
    if design:
        log("vision", f"design review: scores={design['scores']} - {design['summary'][:200]}")
    log("vision", f"report: {rel(out / 'vision-report.json')}")
    return 0 if report["status"] != "unavailable" else 1


if __name__ == "__main__":
    raise SystemExit(main())
