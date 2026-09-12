"""Turn a raw model reply into the clean replacement snippet for an edit region."""

from __future__ import annotations

import re

_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
_PROSE = re.compile(r"^\s*(here is|here's|this fix|explanation|note:|the fix)", re.I)


def _is_close(line: str, fence: str) -> bool:
    s = line.strip()
    return len(s) >= len(fence) and set(s) == {fence[0]}


def _trim(lines: list[str], drop_prose: bool = False) -> str:
    skip = (lambda l: not l.strip() or (drop_prose and _PROSE.match(l)))
    while lines and skip(lines[0]):
        lines = lines[1:]
    while lines and skip(lines[-1]):
        lines = lines[:-1]
    return "\n".join(lines).rstrip()


def extract_code(raw: str) -> str:
    """First complete fenced block; unclosed fence -> rest; no fence -> prose-stripped text."""
    lines = _THINK.sub("", raw or "").splitlines()
    start = next((i for i, l in enumerate(lines) if _FENCE.match(l)), None)
    if start is None:
        return _trim(lines, drop_prose=True)
    fence = _FENCE.match(lines[start]).group(1)
    body = lines[start + 1:]
    end = next((i for i, l in enumerate(body) if _is_close(l, fence)), len(body))
    return _trim(body[:end])


if __name__ == "__main__":
    html = ('Here is the fix:\n\n```html\n<button class="bag-button" aria-label="Open bag"></button>\n```\n'
            'This fix adds an accessible name.\n```\nother\n```')
    assert extract_code(html) == '<button class="bag-button" aria-label="Open bag"></button>'
    js = "<think>hmm</think>```javascript\nif (e.key === 'Tab') {\n  trap(e);\n}\n```"
    assert extract_code(js) == "if (e.key === 'Tab') {\n  trap(e);\n}"
    bare = "Here's the corrected line:\n<label for=\"x\">Email</label>\nExplanation: adds a label."
    assert extract_code(bare) == '<label for="x">Email</label>'
    assert extract_code("```html\n    <div>\n      <p>cut") == "    <div>\n      <p>cut"
    indented = "~~~\n\n      <input id=\"customer-email\" aria-label=\"Email\" />   \n\n~~~\n"
    assert extract_code(indented) == '      <input id="customer-email" aria-label="Email" />'
    assert extract_code("`````js\nconst a = '```';\n`````") == "const a = '```';"
    print("patch_parse self-test: ok")
