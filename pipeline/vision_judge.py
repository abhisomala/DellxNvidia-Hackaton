"""Ollama client for GuardRail's vision judge: gemma4:26b looking at screenshots.

Every call goes to ``/api/chat`` with the images attached, a JSON schema in
``format`` (Ollama's structured outputs, so the reply is constrained to the
schema rather than trusted to follow a "respond in JSON" instruction), and
Google's recommended Gemma 4 sampling (temperature 1.0, top_p 0.95, top_k 64).

``think`` is chosen per call: the judging passes (contrast estimation, focus
visibility, layout, reflow, design review) reason first; the regression
re-check is a simpler before/after comparison and runs without thinking.

The model is ``guardrail-vision``, built from ``vision/Modelfile`` (FROM
gemma4:26b with ``num_ctx`` pinned).  ``check_model`` refuses to run against a
model that lacks the vision capability or a pinned context.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
MODEL = os.environ.get("GUARDRAIL_VISION_MODEL", "guardrail-vision")
BASE_MODEL = "gemma4:26b"
SAMPLING = {"temperature": 1.0, "top_p": 0.95, "top_k": 64}
JUDGE_TIMEOUT_S = int(os.environ.get("GUARDRAIL_VISION_TIMEOUT_S", "420"))
RECHECK_TIMEOUT_S = 180
SHOW_TIMEOUT_S = 15
KEEP_ALIVE = "10m"

CATEGORIES = ("contrast", "focus-visible", "text-clipping", "color-only", "target-size", "reflow")
SEVERITIES = ("critical", "serious", "moderate", "minor")
DESIGN_AREAS = ("typography", "color", "spacing", "hierarchy", "layout", "imagery", "interaction")


class VisionModelError(RuntimeError):
    """The vision model could not be reached or did not return a usable answer."""


# --- schemas -------------------------------------------------------------------

BOX = {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}

FINDINGS_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image": {"type": "integer"},
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                    "visible_text": {"type": "string"},
                    "box_2d": BOX,
                    "evidence": {"type": "string"},
                    "title": {"type": "string"},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    "confidence": {"type": "number"},
                    "recommendation": {"type": "string"},
                },
                "required": ["image", "category", "visible_text", "box_2d", "evidence", "title",
                             "severity", "confidence", "recommendation"],
            },
        }
    },
    "required": ["findings"],
}

FOCUS_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image": {"type": "integer"},
                    "change_seen": {"type": "string"},
                    "indicator_contrast": {"type": "string", "enum": ["no-indicator", "low", "adequate", "strong"]},
                    "indicator_visible": {"type": "boolean"},
                    "confidence": {"type": "number"},
                },
                "required": ["image", "change_seen", "indicator_contrast", "indicator_visible", "confidence"],
            },
        }
    },
    "required": ["items"],
}

CONTRAST_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image": {"type": "integer"},
                    "text_read": {"type": "string"},
                    "foreground": {"type": "string"},
                    "background": {"type": "string"},
                    "evidence": {"type": "string"},
                    "estimated_ratio": {"type": "number"},
                    "passes": {"type": "boolean"},
                    "confidence": {"type": "number"},
                },
                "required": ["image", "text_read", "foreground", "background", "evidence",
                             "estimated_ratio", "passes", "confidence"],
            },
        }
    },
    "required": ["items"],
}

TARGETS_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image": {"type": "integer"},
                    "observation": {"type": "string"},
                    "is_problem": {"type": "boolean"},
                    "confidence": {"type": "number"},
                },
                "required": ["image", "observation", "is_problem", "confidence"],
            },
        }
    },
    "required": ["items"],
}

DESIGN_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "improvements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "enum": list(DESIGN_AREAS)},
                    "image": {"type": "integer"},
                    "visible_text": {"type": "string"},
                    "box_2d": BOX,
                    "issue": {"type": "string"},
                    "recommendation": {"type": "string"},
                    "css_suggestion": {"type": "string"},
                    "accessibility_benefit": {"type": "string"},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                },
                "required": ["area", "image", "visible_text", "box_2d", "issue", "recommendation",
                             "css_suggestion", "accessibility_benefit", "priority"],
            },
        },
        "scores": {
            "type": "object",
            "properties": {k: {"type": "integer"} for k in ("typography", "color", "spacing", "hierarchy", "overall")},
            "required": ["typography", "color", "spacing", "hierarchy", "overall"],
        },
    },
    "required": ["summary", "strengths", "improvements", "scores"],
}

REGRESSION_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "image": {"type": "integer"},
                    "what_changed": {"type": "string"},
                    "regression": {"type": "boolean"},
                    "category": {"type": "string", "enum": [*CATEGORIES, "layout", "none"]},
                    "confidence": {"type": "number"},
                },
                "required": ["image", "what_changed", "regression", "category", "confidence"],
            },
        }
    },
    "required": ["items"],
}


# --- transport -------------------------------------------------------------------


CONNECTION_RETRY_DELAY_S = 8


def _request(path: str, payload: dict, timeout: float) -> dict:
    """POST to Ollama.  A dropped or refused connection (the server restarting) is
    retried once; a timeout, an HTTP error or a bad body is not."""
    body = json.dumps(payload).encode()
    for attempt in (1, 2):
        request = urllib.request.Request(f"{OLLAMA_URL}{path}", data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise VisionModelError(f"{path} on {OLLAMA_URL} returned HTTP {exc.code}: {detail}") from exc
        except (ConnectionError, http.client.RemoteDisconnected, urllib.error.URLError) as exc:
            reason = getattr(exc, "reason", exc)
            if attempt == 1 and not isinstance(reason, TimeoutError):
                time.sleep(CONNECTION_RETRY_DELAY_S)
                continue
            raise VisionModelError(f"{path} on {OLLAMA_URL} failed after {attempt} attempt(s): {exc}") from exc
        except (OSError, ValueError) as exc:  # timeouts and bad JSON land here
            raise VisionModelError(f"{path} on {OLLAMA_URL} failed (timeout {timeout}s): {exc}") from exc
    raise AssertionError("unreachable")


def check_model(model: str = MODEL) -> dict:
    """Confirm the judge model exists, can see images, and has a pinned context."""
    info = _request("/api/show", {"model": model}, SHOW_TIMEOUT_S)
    capabilities = info.get("capabilities") or []
    if "vision" not in capabilities:
        raise VisionModelError(f"{model} has no vision capability (capabilities: {capabilities})")
    match = re.search(r"^num_ctx\s+(\d+)", info.get("parameters") or "", re.MULTILINE)
    if not match:
        raise VisionModelError(
            f"{model} has no pinned num_ctx; build it with `bash vision/setup.sh` (vision/Modelfile)"
        )
    details = info.get("details") or {}
    return {
        "model": model,
        "base_model": BASE_MODEL,
        "capabilities": capabilities,
        "num_ctx": int(match.group(1)),
        "parameter_size": details.get("parameter_size"),
        "quantization": details.get("quantization_level"),
        "modified_at": info.get("modified_at"),
    }


def loaded_runners() -> list[dict]:
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/ps", timeout=SHOW_TIMEOUT_S) as response:
            return json.loads(response.read()).get("models") or []
    except (OSError, ValueError):
        return []


def unload(model: str) -> None:
    _request("/api/generate", {"model": model, "keep_alive": 0}, 120)


def make_room(num_ctx: int, family: str = "gemma4") -> list[str]:
    """Unload loaded runners of the same weights at a different context.

    Ollama runs one runner per (weights, context); it does not evict an idle runner
    of the same weights to load another, so a mismatched one blocks our calls until
    its keep-alive expires.  Unloading waits for its in-flight requests.
    """
    released = []
    for runner in loaded_runners():
        if (runner.get("details") or {}).get("family") == family and runner.get("context_length") not in (None, num_ctx):
            unload(runner["name"])
            released.append(f"{runner['name']} (context {runner['context_length']})")
    return released


def release() -> list[str]:
    """Unload the vision runner if it is loaded under its own name, so the next plain
    gemma4:26b call never waits behind it.  If both names share one runner this costs
    one reload (~9 s); if they do not, it prevents a wait until the keep-alive expires."""
    base = MODEL.split(":")[0]
    ours = [r for r in loaded_runners() if r.get("name", "").split(":")[0] == base]
    for runner in ours:
        unload(runner["name"])
    return [f"{r['name']} (context {r.get('context_length')})" for r in ours]


def encode_png(data: bytes) -> str:
    return base64.b64encode(data).decode()


def normalise_confidence(value: Any) -> float:
    """Models sometimes answer on a 1-5, 1-10 or percentage scale; map to 0..1."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number != number or number < 0:  # NaN or negative
        return 0.0
    for scale in (1, 5, 10, 100):
        if number <= scale:
            return round(number / scale, 3)
    return 1.0


def chat(messages: list[dict], schema: dict, *, think: bool, timeout: float = JUDGE_TIMEOUT_S,
         model: str = MODEL) -> dict:
    """One structured call; returns the parsed object plus the thinking trace and stats."""
    started = time.monotonic()
    data = _request("/api/chat", {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": think,
        "format": schema,
        "options": SAMPLING,
        "keep_alive": KEEP_ALIVE,
    }, timeout)
    message = data.get("message") or {}
    content = message.get("content") or ""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as exc:
        raise VisionModelError(f"{model} returned content that is not JSON: {content[:300]!r}") from exc
    if not isinstance(parsed, dict):
        raise VisionModelError(f"{model} returned {type(parsed).__name__}, not an object")
    return {
        "data": parsed,
        "thinking": message.get("thinking") or "",
        "raw": content,
        "stats": {
            "latency_s": round(time.monotonic() - started, 2),
            "think": think,
            "prompt_tokens": data.get("prompt_eval_count"),
            "output_tokens": data.get("eval_count"),
            "load_s": round((data.get("load_duration") or 0) / 1e9, 2),
        },
    }
