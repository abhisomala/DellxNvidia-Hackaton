"""Minimal "does it basically parse" check for a patched source file."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from html.parser import HTMLParser
from pathlib import Path

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr"}
IMPLICIT = {"p", "li", "option", "td", "tr", "th", "thead", "tbody"}
NODE_FALLBACK = "/home/dell/.nvm/versions/node/v22.23.2/bin/node"


class _TagBalance(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, int]] = []
        self.error = ""

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag not in VOID and tag not in IMPLICIT:
            self.stack.append((tag, self.getpos()[0]))

    def handle_endtag(self, tag: str) -> None:
        if self.error or tag in VOID or tag in IMPLICIT:
            return
        line = self.getpos()[0]
        if not self.stack or self.stack[-1][0] != tag:
            open_tag = f"<{self.stack[-1][0]}> from line {self.stack[-1][1]}" if self.stack else "nothing"
            self.error = f"line {line}: stray or mismatched </{tag}> (open: {open_tag})"
        else:
            self.stack.pop()

    # handle_startendtag ('<x />') does not call handle_starttag -> nothing pushed.


def _check_html(text: str) -> tuple[bool, str]:
    parser = _TagBalance()
    parser.feed(text)
    parser.close()
    if parser.error:
        return False, parser.error
    if parser.stack:
        tag, line = parser.stack[-1]
        return False, f"unclosed <{tag}> opened at line {line}"
    return True, ""


def _check_js(text: str, suffix: str) -> tuple[bool, str]:
    node = shutil.which("node") or NODE_FALLBACK
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False) as fh:
        fh.write(text)
    try:
        proc = subprocess.run([node, "--check", fh.name], capture_output=True, text=True)
    finally:
        Path(fh.name).unlink()
    lines = [l for l in proc.stderr.splitlines()
             if l.strip() and not l.lstrip().startswith("at ") and not l.startswith("Node.js")]
    return proc.returncode == 0, "\n".join(lines[-5:]).replace(fh.name, "patched" + suffix)


def validate(file_name: str, text: str) -> tuple[bool, str]:
    """Return (ok, error message or "") for the whole patched file text."""
    if not text.strip():
        return False, "patched file is empty"
    suffix = Path(file_name.strip()).suffix.lower()
    if suffix in {".html", ".htm"}:
        return _check_html(text)
    if suffix in {".js", ".mjs", ".cjs"}:
        return _check_js(text, suffix)
    if suffix == ".css":
        depth = 0
        for ch in text:
            depth += {"{": 1, "}": -1}.get(ch, 0)
            if depth < 0:
                return False, "unbalanced '}' in CSS"
        return (depth == 0, "" if depth == 0 else "unclosed '{' in CSS")
    return True, ""


if __name__ == "__main__":
    demo = Path(__file__).resolve().parent.parent / "demo"
    html, js = (demo / "index.html").read_text(), (demo / "script.js").read_text()
    checks = [
        ("index.html original", validate("index.html", html), True),
        ("script.js original", validate("script.js", js), True),
        ("index.html minus one </div>", validate("index.html", html.replace("</div>", "", 1)), False),
        ("script.js minus last '}'", validate("script.js", js[::-1].replace("}", "", 1)[::-1]), False),
    ]
    for name, (ok, err), want in checks:
        print(f"{'PASS' if ok == want else 'FAIL'}  {name}: ok={ok} {err!r}")
    raise SystemExit(0 if all(r[0] == w for _, r, w in checks) else 1)
