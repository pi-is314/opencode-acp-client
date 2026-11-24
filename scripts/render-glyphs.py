#!/usr/bin/env python3
"""Render the epilogue wordmark's glyphs to a PNG, the way a TERMINAL paints them.

Why this exists: the glyphs in `src/index.ts` are strings of half-block characters (`█ ▀ ▄ _ ^ ~`)
and printing those strings is not the same as seeing them. A terminal cell is about twice as tall
as it is wide, and `▄` fills the BOTTOM half of its cell — so `['▄   ', '█   ', …]` draws a stem
that runs straight into the next row's `█` and looks continuous, which is exactly the bug that took
several rounds to see. Rendering the cells as pixels, with the real 1:2 aspect, makes it obvious.

    python3 scripts/render-glyphs.py <out.png>

Colours follow the wordmark's own two palettes: `open`/`acp` are the dark one, `code`/`client` the
bright one, and `_`/`~` are the dim interior cells.
"""

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src' / 'index.ts'

CELL_W = 24
CELL_H = 48           # a terminal cell, in pixels: twice as tall as wide

DARK_FG = (0, 43, 54)
DARK_BG = (38, 38, 38)
BRIGHT_FG = (163, 185, 188)
BRIGHT_BG = (68, 68, 68)


def read_glyphs():
    text = SRC.read_text(encoding='utf-8')

    def table(name):
        m = re.search(name + r'\s*=\s*\[(.*?)\];', text, re.S)
        rows = re.findall(r"'([^']*)'", m.group(1))
        return rows

    open_rows = table('NATIVE_OPEN')[:4]
    code_rows = table('NATIVE_CODE')[:4]
    body = re.search(r'EXTRA_GLYPHS[^{]*\{(.*?)\n\};', text, re.S).group(1)
    extra = {
        key: re.findall(r"'([^']*)'", rows)
        for key, rows in re.findall(r"'?([a-z ])'?:\s*\[([^\]]*)\]", body)
    }
    # the originals, addressed the way `glyphRow()` addresses them
    for i, ch in enumerate('open'):
        extra.setdefault(ch, [r[i * 5:i * 5 + 4] for r in open_rows])
    for i, ch in enumerate('code'):
        extra.setdefault(ch, [r[i * 5:i * 5 + 4] for r in code_rows])
    return extra


def cells_of(glyph_rows):
    """Yield (col, subrow, lit) for every half-cell of a 4-row glyph.

    A glyph row is one CELL tall, and a cell is two sub-rows: the upper and lower halves that `▀`
    and `▄` select. That is the whole point — `▄` on row 0 lights SUBROW 1 and leaves subrow 0
    blank, so the stem starts halfway down the cell rather than at its top.
    """
    for row, line in enumerate(glyph_rows):
        for col, ch in enumerate(line):
            if ch == '█':
                yield col, row * 2, True
                yield col, row * 2 + 1, True
            elif ch in '▀^':
                yield col, row * 2, True
            elif ch == '▄':
                yield col, row * 2 + 1, True
            elif ch in '_~':
                yield col, row * 2, 'dim'
                yield col, row * 2 + 1, 'dim'


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'glyphs.png')
    glyphs = read_glyphs()
    word = 'acp client'
    # label row on top, then the 4 glyph rows (the ascender gap is row 0)
    pad = 12
    label_h = 30
    width = pad * 2 + sum(4 * CELL_W + CELL_W for _ in word) + 80
    height = pad * 2 + label_h + 4 * CELL_H + 20
    img = Image.new('RGB', (width, height), (250, 250, 250))
    d = ImageDraw.Draw(img)

    x = pad
    for index, ch in enumerate(word):
        rows = glyphs.get(ch, ['    '] * 4)
        # the dark palette for the first word, the bright one for the second
        bright = index > 3
        fg = BRIGHT_FG if bright else DARK_FG
        bg = BRIGHT_BG if bright else DARK_BG
        d.text((x, pad), ch, fill=(0, 0, 0))
        for col, subrow, lit in cells_of(rows):
            cx = x + col * CELL_W
            cy = pad + label_h + subrow * (CELL_H // 2)
            colour = bg if lit == 'dim' else fg
            if lit:
                d.rectangle((cx, cy, cx + CELL_W - 1, cy + CELL_H // 2 - 1), fill=colour)
        x += 4 * CELL_W + CELL_W

    img.save(out)
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
