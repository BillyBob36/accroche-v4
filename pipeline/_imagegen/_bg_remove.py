"""Convert a uniform background to alpha using Pillow.

Strategy: sample corner pixels to detect the background color, then map each
pixel's distance to that color into an alpha channel. Works well for icons,
logos, sprites generated with a clean uniform background.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image


def remove_uniform_bg(
    src: Path,
    dst: Path | None = None,
    tolerance: int = 32,
    feather: int = 16,
) -> Path:
    """Convert near-background pixels to alpha.

    tolerance: distance below which pixels become fully transparent (0-441 RGB space).
    feather: distance over which alpha smoothly transitions from 0 to 255.
    """
    src = Path(src)
    dst = Path(dst) if dst else src
    img = Image.open(src).convert("RGBA")
    w, h = img.size
    px = img.load()

    # Sample 4 corners + 4 edge midpoints, take median per channel
    samples = [
        px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1],
        px[w // 2, 0], px[w // 2, h - 1], px[0, h // 2], px[w - 1, h // 2],
    ]
    rs = sorted(s[0] for s in samples)
    gs = sorted(s[1] for s in samples)
    bs = sorted(s[2] for s in samples)
    bg = (rs[len(rs) // 2], gs[len(gs) // 2], bs[len(bs) // 2])

    # Per-pixel distance → alpha
    out = img.copy()
    out_px = out.load()
    t2 = tolerance * tolerance
    span = max(feather, 1)
    span_sq_inv = 1.0 / (span * span)
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            dr, dg, db = r - bg[0], g - bg[1], b - bg[2]
            d2 = dr * dr + dg * dg + db * db
            if d2 <= t2:
                a = 0
            else:
                # smooth transition over `feather` distance
                excess_sq = d2 - t2
                ratio = excess_sq * span_sq_inv
                if ratio >= 1:
                    a = 255
                else:
                    a = int(255 * ratio)
            out_px[x, y] = (r, g, b, a)
    out.save(dst, format="PNG")
    return dst
