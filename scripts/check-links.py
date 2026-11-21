#!/usr/bin/env python3
"""Every relative link in the docs resolves.

A doc-heavy project rots at the links: a renamed section, a file that moved, a
bilingual pair where only one side was written. This repository keeps a Chinese
and an English copy of most documents, so an unmirrored file shows up here as a
broken link rather than as a reader's dead end.

Usage: python3 scripts/check-links.py [--quiet]
Exit status is non-zero if any relative link points at a missing file.
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LINK = re.compile(r"\]\(([^)\s]+)\)")
SKIP = ("http://", "https://", "#", "mailto:")


def tracked_markdown() -> list[pathlib.Path]:
    """Ask git, so a stray file in the working tree is not judged as a doc.

    A container built without `.git` (the Linux gate image) has no index; there,
    fall back to walking the tree so the same links are still checked. "Tracked"
    becomes "present", which is the right question for a link.
    """
    try:
        out = subprocess.run(
            ["git", "ls-files", "*.md"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return [ROOT / line for line in out.splitlines() if line]
    except (FileNotFoundError, subprocess.CalledProcessError):
        skip = {".git", "node_modules", ".artifacts", ".cache"}
        return sorted(
            path
            for path in ROOT.rglob("*.md")
            if not any(part in skip for part in path.relative_to(ROOT).parts)
        )


def main() -> int:
    quiet = "--quiet" in sys.argv
    broken: list[str] = []
    checked = 0

    for path in tracked_markdown():
        if not path.exists():
            continue
        for match in LINK.finditer(path.read_text(encoding="utf-8")):
            target = match.group(1)
            if target.startswith(SKIP):
                continue
            relative = target.split("#", 1)[0]
            if not relative:
                continue
            checked += 1
            if not (path.parent / relative).resolve().exists():
                broken.append(f"{path.relative_to(ROOT)} -> {target}")

    if broken:
        for entry in broken:
            print(f"  ✗ {entry}", file=sys.stderr)
        print(f"✗ {len(broken)} broken link(s) out of {checked}", file=sys.stderr)
        return 1

    if not quiet:
        print(f"  ✓ {checked} relative links resolve")
    return 0


if __name__ == "__main__":
    sys.exit(main())
