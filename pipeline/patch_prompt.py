"""Locate a violation in its source file and build the patch prompt for the local model.

Localization is Path 2's own ``remediation/src/lib/locate.mjs`` (run through
``pipeline/locate_cli.mjs``); the per-rule fix guidance is Path 2's
``remediation/rules/guidance.json``.  The model only ever sees one edit region
and must answer with the replacement text for exactly that region.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
GUIDANCE = json.loads((REPO_ROOT / "remediation" / "rules" / "guidance.json").read_text())

WHOLE_FILE_MAX_LINES = 40  # at or below this, the edit region is the whole file
CONTEXT_MAX_LINES = 220  # at or below this, the numbered file is shown for context
MAX_FIELD = 2000

# Specifics for this plain HTML/JS demo; guidance.json is written for React apps.
RULE_NOTES = {
    "button-name": "Plain HTML (not JSX): add aria-label=\"<verb + object>\" to the empty button, describing what it does.",
    "label": (
        "Plain HTML (not JSX, so use for=, not htmlFor=): add a visible <label for=\"<input id>\"> whose text says what the "
        "field is (the placeholder text is a good label) right before the input, inside the same wrapper, like sibling fields."
    ),
    "keyboard-unreachable": (
        "This is plain browser JavaScript, not React: no JSX, no hooks, no state setters. Do NOT add buttons or "
        "elements. Fix only the Tab handling inside the EXISTING modal keydown listener: instead of always focusing "
        "one fixed element, collect the focusable elements inside the modal at keydown time (a[href], button, input, "
        "select, textarea, [tabindex]:not([tabindex=\"-1\"])) with Array.from; if the list is empty, return; call "
        "event.preventDefault(); find the index of document.activeElement in the list; if it is -1 (focus is not on one "
        "of them) focus the first (Tab) or the last (Shift+Tab); otherwise focus (index + step + length) % length with "
        "step 1 for Tab and -1 for Shift+Tab, so every control is reached in DOM order, focus wraps, and focus never "
        "leaves the modal. Keep the existing Escape branch (modal.hidden = true) and every other line of the file identical."
    ),
    "keyboard-trap": (
        "This is plain browser JavaScript, not React. The dialog already has a Close button: do NOT add buttons. "
        "Add an Escape branch to the EXISTING modal keydown listener that closes the dialog the same way the Close "
        "button does (modal.hidden = true), keep Tab inside the dialog, and leave every other line identical."
    ),
}


# Rules whose defect lives in behaviour (event handlers), not markup.  The same
# test is locate.mjs's RULE_BOOSTS entry, which ranks the file holding the
# keydown / focus logic first when no file is forced on it.
BEHAVIOUR_RULE = re.compile(r"^keyboard-|focus")
LOCATE_TIMEOUT_S = 60


def locate_violation(violation: dict[str, Any], repo_root: Path) -> dict[str, Any]:
    """Run locate.mjs on the violation; returns {file, line, snippet, totalLines, method, ...}.

    ``file`` is relative to the scanned page's directory.  For markup rules the
    scanned file is passed as a hint.  For keyboard/focus rules the scan names
    the page (``index.html``) but the defect is in the script, so no file is
    forced and only the element's opening tag is used as a token source: the
    dialog's full rendered HTML repeats every class of its children, which
    would otherwise outscore the keydown handler and land the patch in markup.
    """
    source_file = Path(violation["source_file"])
    app_root = repo_root / source_file.parent
    rule_id = violation["rule_id"]
    behavioural = bool(BEHAVIOUR_RULE.search(rule_id))
    html = violation.get("html") or ""
    if behavioural:
        opening = re.match(r"\s*<[^>]*>", html)
        html = opening.group(0) if opening else html
    payload = {
        "id": f"{rule_id}#0",
        "rule_id": rule_id,
        "selector": violation.get("selector") or "",
        "html": html,
        "description": violation.get("description") or "",
        "help": violation.get("help") or "",
        "repro": violation.get("repro"),
    }
    if not behavioural:
        payload["source"] = {"file": source_file.name}
    try:
        proc = subprocess.run(
            ["node", str(repo_root / "pipeline" / "locate_cli.mjs"), str(app_root)],
            input=json.dumps(payload), capture_output=True, text=True, cwd=repo_root,
            timeout=LOCATE_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"locate.mjs did not answer within {LOCATE_TIMEOUT_S}s") from exc
    if proc.returncode != 0:
        raise RuntimeError(f"locate.mjs exited {proc.returncode}: {(proc.stderr or '').strip()[-800:]}")
    return json.loads(proc.stdout)


def edit_region(source_text: str, line: int | None) -> tuple[int, int]:
    """1-indexed inclusive line range the model must rewrite."""
    total = len(source_text.splitlines())
    if total <= WHOLE_FILE_MAX_LINES:
        return 1, total
    if line is None:
        raise ValueError("file is too long to rewrite whole and no line was located")
    return line, line


def _numbered(lines: list[str]) -> str:
    return "\n".join(f"{i:4d}| {l}" for i, l in enumerate(lines, 1))


def _clip(value: Any) -> str:
    text = str(value or "")
    return text if len(text) <= MAX_FIELD else text[:MAX_FIELD] + " ...[truncated]"


def build_prompt(
    violation: dict[str, Any], source_file: str, source_text: str, region: tuple[int, int]
) -> str:
    """Short, strict prompt: violation, guidance, context, the region, output rules."""
    rule_id = violation["rule_id"]
    lines = source_text.splitlines()
    start, end = region
    whole = start == 1 and end == len(lines)
    lang = "html" if source_file.endswith((".html", ".htm")) else "js" if source_file.endswith((".js", ".mjs")) else ""

    out = ["You are an accessibility remediation engineer. Fix exactly ONE violation with a minimal source edit.", ""]
    out.append("## Violation")
    out.append(f"- rule_id: {rule_id}")
    out.append(f"- selector: {violation.get('selector', '')}")
    out.append(f"- description: {violation.get('description', '')}")
    if violation.get("help"):
        out.append(f"- help: {_clip(violation['help'])}")
    if violation.get("html"):
        out.append(f"- rendered HTML: {_clip(violation['html'])}")
    if violation.get("failure_summary"):
        out.append(f"- scanner observation: {_clip(violation['failure_summary'])}")
    repro = violation.get("repro")
    if repro:
        out.append(
            f"- reproduced by: open via {repro.get('open_selector', '?')}, press {', '.join(repro.get('keys', []))}; "
            f"observed: {repro.get('observed', '')}"
        )
    out.append("")
    out.append("## How to fix this rule")
    guidance = GUIDANCE.get(rule_id)
    out.append(guidance["fix"] if guidance else "Apply the standard fix: semantic HTML first, ARIA only where needed.")
    if rule_id in RULE_NOTES:
        out.append(f"For this app (takes precedence): {RULE_NOTES[rule_id]}")
    out.append("")
    if not whole and len(lines) <= CONTEXT_MAX_LINES:
        out.append(f"## File {source_file} (line numbers for context only)")
        out.append("```")
        out.append(_numbered(lines))
        out.append("```")
        out.append("")
    span = f"lines {start}-{end}" if start != end else f"line {start}"
    out.append(f"## REPLACE {span} of {source_file}{' (the whole file)' if whole else ''}, which currently read:")
    out.append(f"```{lang}")
    out.append("\n".join(lines[start - 1 : end]))
    out.append("```")
    out.append("")
    out.append("## Output rules")
    out.append(f"1. Output ONLY one fenced code block containing the replacement text for exactly {span}. No prose, no line numbers.")
    out.append("2. Make the smallest change that fixes the violation; leave all other text identical.")
    out.append("3. Keep every existing id, class, type, data-* attribute and event wiring.")
    out.append("4. Keep the same indentation. Do not add new files.")
    return "\n".join(out)
