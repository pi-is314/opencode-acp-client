#!/usr/bin/env python3
"""Generate the project logo: "OC" drawn exactly as the exit wordmark draws it.

Two outputs, both from the same geometry so they can never drift apart:

    logo.png   512x512, transparent, the GitHub repository avatar (root of the repo)
    logo.svg   the same marks as rectangles — crisp at any size, for the README header

The marks are the wordmark's OWN glyphs, lifted from src/index.ts:

    O  = the first letter of NATIVE_OPEN   '█▀▀█' / '█__█' / '▀▀▀▀'
    C  = the first letter of NATIVE_CODE   '█▀▀▀' / '█___' / '▀▀▀▀'

and the two-tone split is its own palette pair: the O in the DARK palette, the C in the BRIGHT
one — the same contrast the wordmark has between `open` and `code`.

A glyph cell is a half-block: `█` fills it, `▀` fills its upper half (a thin line), `_` is a dark
interior cell. Painting that faithfully is what makes the letters read as thin strokes rather than
solid blocks.
"""

from pathlib import Path

from PIL import Image, ImageDraw

# --- the wordmark's glyphs, verbatim ----------------------------------------
NATIVE_OPEN = [
    '                   ',
    '█▀▀█ █▀▀█ █▀▀█ █▀▀▄',
    '█__█ █__█ █^^^ █__█',
    '▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀',
]
NATIVE_CODE = [
    '             ▄     ',
    '█▀▀▀ █▀▀█ █▀▀█ █▀▀█',
    '█___ █__█ █__█ █^^^',
    '▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀',
]

# The colours the terminal actually paints, sampled from a real run (a 256-colour terminal maps
# the escape codes onto these). Kept as literals so the image does not depend on a theme.
DARK_STROKE = (0, 43, 54)        # `open`: the dark teal of WORDMARK_FG on this theme
DARK_INNER = (150, 160, 163)     # its interior cell — light, so it reads as a shadow
                                  # rather than a hole (38,38,38 was near-black)
BRIGHT_STROKE = (163, 185, 188)  # `code`: the light grey of WORDMARK_BRIGHT
BRIGHT_INNER = (140, 152, 156)   # its interior cell — deeper than the O's, because the C's
                                  # stroke is light and the interior has to read as a shadow
                                  # rather than as more of the same letter

OUT = Path(__file__).resolve().parent.parent  # the repo root: GitHub reads logo.png from here

# A terminal cell is about twice as tall as it is wide; the wordmark is drawn in cells.
CELL_ASPECT = 2.0

# The logo's panel: an almost-white fill with a faint edge, so the two-tone mark keeps its
# contrast on either theme. Kept pale on purpose — a dark panel would fight the O's dark stroke.
PANEL = (247, 249, 250, 255)
PANEL_EDGE = (226, 232, 235, 255)


def column(rows, index):
    """One letter out of a wordmark row set: 4 columns, starting at `index * 5`."""
    return [row[index * 5:index * 5 + 4] for row in rows]


def cells(glyph):
    """Flatten a 4x4 glyph into `(col, row, part)` triples, `part` being full/upper/lower/inner.

    Row 0 of the wordmark is the ascender gap, so the printed glyph is rows 1..3.

    ★ `█` is a WHOLE cell in the stroke colour, and `_` a whole cell in the inner one. That is what
    makes the letter read as a frame: `█▀▀█` is a solid left cell, a lit band across the top, and a
    solid right cell — the vertical edges and the top line, with the middle row `█__█` giving the
    two edges and a dark gap between them. Painting `█` as a half-cell instead turned the letters
    into solid blocks (the first version of this script).
    """
    out = []
    for r, line in enumerate(glyph):
        for c, ch in enumerate(line):
            if ch == '█':
                out.append((c, r, 'full'))
            elif ch in '▀^':
                out.append((c, r, 'upper'))
            elif ch == '▄':
                out.append((c, r, 'lower'))
            elif ch in '_~':
                out.append((c, r, 'inner'))
    return out


def draw_png(path, size=512, pad_ratio=0.14, gap_ratio=0.16):
    """Both letters, centred, on a transparent canvas.

    The wordmark's own proportions are kept: a glyph is 4 cells wide and 3 cells tall (twice as
    tall as wide, because a terminal cell is roughly 1:2), and the letters are separated by one
    cell plus the wordmark's gap.
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # ★ A very pale rounded panel behind the marks.
    #
    # Without it the logo disappears into whichever theme it is shown on: the O's stroke is dark
    # teal and the C's is light grey, so one of the two always sat on a background too close to
    # it. A near-white panel with a soft border gives BOTH contrasts somewhere to work, and the
    # rounded corners keep it looking like a mark rather than a screenshot.
    radius = size * 0.22
    inset = size * 0.04
    d.rounded_rectangle(
        (inset, inset, size - inset, size - inset),
        radius=radius,
        fill=PANEL,
        outline=PANEL_EDGE,
        width=max(1, round(size * 0.006)),
    )

    # ★ A TERMINAL CELL IS TALLER THAN IT IS WIDE (roughly 1:2). The wordmark is drawn in cells,
    # so a faithful image must use the same rectangle: with square cells the `█` edges came out as
    # fat slabs and the letter looked like a thick border instead of the thin frame the terminal
    # shows. `CELL_ASPECT` is that ratio.
    cell_w = 1.0
    cell_h = CELL_ASPECT                    # 2.0 — one cell is twice as tall as it is wide
    glyph_w = 4 * cell_w
    glyph_h = 3 * cell_h
    gap = gap_ratio * glyph_w              # the blank between O and C
    total_w = glyph_w * 2 + gap
    total_h = glyph_h

    pad = pad_ratio * size
    scale = min((size - 2 * pad) / total_w, (size - 2 * pad) / total_h)
    origin_x = (size - total_w * scale) / 2
    origin_y = (size - total_h * scale) / 2

    for index, (glyph, stroke, inner) in enumerate(
        ((column(NATIVE_OPEN, 0), DARK_STROKE, DARK_INNER),
         (column(NATIVE_CODE, 0), BRIGHT_STROKE, BRIGHT_INNER))
    ):
        x0 = origin_x + index * (glyph_w + gap) * scale
        for col, row, part in cells(glyph):
            if row == 0:
                continue                    # the ascender gap is not printed for these letters
            r = row - 1                     # rows 1..3 are the 3 printed rows
            cx = x0 + col * cell_w * scale
            cy = origin_y + r * cell_h * scale
            # ★ An `inner` cell IS painted, in the palette's own interior colour. That is what the
            # terminal shows: `_` emits a dark BACKGROUND (`48;5;235m`), not transparency, so the
            # letter reads as a frame around a dark interior. Leaving it transparent drew an
            # outline on a light page, which is not what the wordmark looks like.
            colour = inner if part == 'inner' else stroke
            w = cell_w * scale
            h = cell_h * scale
            if part == 'full' or part == 'inner':
                box = (cx, cy, cx + w, cy + h)
            elif part == 'upper':
                box = (cx, cy, cx + w, cy + h / 2)
            else:                            # lower
                box = (cx, cy + h / 2, cx + w, cy + h)
            d.rectangle(box, fill=colour + (255,))

    img.save(path)
    return path


def draw_svg(path, size=512, pad_ratio=0.14, gap_ratio=0.16):
    cell_w, cell_h = 1.0, CELL_ASPECT
    glyph_w, glyph_h = 4 * cell_w, 3 * cell_h
    gap = gap_ratio * glyph_w
    total_w = glyph_w * 2 + gap
    pad = pad_ratio * size
    scale = min((size - 2 * pad) / total_w, (size - 2 * pad) / glyph_h)
    ox = (size - total_w * scale) / 2
    oy = (size - glyph_h * scale) / 2

    rects = []
    for index, (glyph, stroke, inner) in enumerate(
        ((column(NATIVE_OPEN, 0), DARK_STROKE, DARK_INNER),
         (column(NATIVE_CODE, 0), BRIGHT_STROKE, BRIGHT_INNER))
    ):
        x0 = ox + index * (glyph_w + gap) * scale
        for col, row, part in cells(glyph):
            if row == 0:
                continue
            r = row - 1
            x = x0 + col * cell_w * scale
            y = oy + r * cell_h * scale
            colour = inner if part == 'inner' else stroke
            h = cell_h * scale if part in ('full', 'inner') else cell_h * scale / 2
            yy = y if part in ('full', 'inner', 'upper') else y + cell_h * scale / 2
            rects.append(
                f'  <rect x="{x:.2f}" y="{yy:.2f}" width="{cell_w * scale:.2f}" '
                f'height="{h:.2f}" fill="rgb({colour[0]},{colour[1]},{colour[2]})"/>'
            )

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {size} {size}">\n'
        '  <!-- Generated by scripts/make-logo.py from src/index.ts\'s wordmark glyphs. -->\n'
        + '\n'.join(rects)
        + '\n</svg>\n'
    )
    path.write_text(svg, encoding='utf-8')
    return path


if __name__ == '__main__':
    png = draw_png(OUT / 'logo.png')
    svg = draw_svg(OUT / 'logo.svg')
    print(f'wrote {png}')
    print(f'wrote {svg}')
