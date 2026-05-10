"""Skeletonize each box's line-art into an SVG path positioned in master coords.

Reads:
  public/crops/box-{id}-line.png
  public/crops/box-{id}-geom.json   (crop_in_master + target_size)

Writes:
  public/lineart-svg/box-{id}-skel.svg

The drawing is placed at its NATURAL position in master coords (where GPT
actually drew it inside the input). We do not force it into any tighter
bounding box — letting the natural extents (hair, shoes, etc.) shine.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import convolve
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parent.parent
MASTER_W, MASTER_H = 2560, 1440
MIN_POLYLINE_PIXELS = 12
RDP_EPSILON = 1.2

_NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def _rdp(points, eps):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = points[a]; bx, by = points[b]
        dx, dy = bx - ax, by - ay
        seg_len2 = dx * dx + dy * dy
        max_d2 = -1.0; max_i = -1
        for i in range(a + 1, b):
            px, py = points[i]
            if seg_len2 == 0:
                d2 = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / seg_len2
                t = max(0.0, min(1.0, t))
                qx, qy = ax + t * dx, ay + t * dy
                d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 > max_d2:
                max_d2 = d2; max_i = i
        if max_d2 > eps * eps:
            keep[max_i] = True
            stack.append((a, max_i)); stack.append((max_i, b))
    return [p for p, k in zip(points, keep) if k]


def _trace_polylines(skel):
    h, w = skel.shape
    kernel = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], dtype=np.int8)
    nb = convolve(skel.astype(np.int8), kernel, mode="constant") * skel
    visited = np.zeros_like(skel, dtype=bool)

    def walk(start_y, start_x):
        path = [(start_x, start_y)]
        visited[start_y, start_x] = True
        cy, cx = start_y, start_x
        while True:
            best = None
            for dy, dx in _NEIGHBORS:
                ny, nx = cy + dy, cx + dx
                if 0 <= ny < h and 0 <= nx < w and skel[ny, nx] and not visited[ny, nx]:
                    best = (ny, nx); break
            if best is None:
                return path
            ny, nx = best
            visited[ny, nx] = True
            path.append((nx, ny))
            cy, cx = ny, nx
            if nb[cy, cx] >= 3 or nb[cy, cx] == 1:
                return path

    polylines = []
    for y, x in np.argwhere(nb == 1):
        if not visited[y, x]:
            polylines.append(walk(int(y), int(x)))
    for y, x in np.argwhere(nb >= 3):
        while True:
            has_unvisited = any(
                0 <= y + dy < skel.shape[0] and 0 <= x + dx < skel.shape[1]
                and skel[y + dy, x + dx] and not visited[y + dy, x + dx]
                for dy, dx in _NEIGHBORS
            )
            if not has_unvisited:
                break
            visited[y, x] = False
            polylines.append(walk(int(y), int(x)))
    for y in range(skel.shape[0]):
        for x in range(skel.shape[1]):
            if skel[y, x] and not visited[y, x]:
                polylines.append(walk(y, x))
    return [p for p in polylines if len(p) >= MIN_POLYLINE_PIXELS]


def _polyline_to_svg_d(points):
    if not points:
        return ""
    head = f"M{points[0][0]},{points[0][1]}"
    tail = "".join(f"L{x},{y}" for x, y in points[1:])
    return head + tail


def skeletonize_one(box_id: str) -> Path:
    geom = json.loads(
        (ROOT / f"public/crops/box-{box_id}-geom.json").read_text(encoding="utf-8")
    )
    crop = geom["crop_in_master"]
    target = geom["target_size"]

    line_path = ROOT / f"public/crops/box-{box_id}-line.png"
    line = Image.open(line_path).convert("L")
    arr = np.array(line)
    is_line = arr < 200

    ys, xs = np.where(is_line)
    if len(xs) == 0:
        print(f"box-{box_id}-skel: empty drawing", flush=True)
        return ROOT / f"public/lineart-svg/box-{box_id}-skel.svg"

    dx0, dx1 = int(xs.min()), int(xs.max())
    dy0, dy1 = int(ys.min()), int(ys.max())
    dw, dh = dx1 - dx0 + 1, dy1 - dy0 + 1

    cropped = is_line[dy0:dy1 + 1, dx0:dx1 + 1]
    skel = skeletonize(cropped)
    polylines = _trace_polylines(skel)
    simplified = [_rdp(p, RDP_EPSILON) for p in polylines]

    paths_svg = "\n".join(
        f'    <path d="{_polyline_to_svg_d(pts)}"/>' for pts in simplified
    )

    sx = crop["w"] / target["w"]
    sy = crop["h"] / target["h"]
    master_x = crop["x"] + dx0 * sx
    master_y = crop["y"] + dy0 * sy

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {MASTER_W} {MASTER_H}" '
        f'preserveAspectRatio="xMidYMid meet">\n'
        f'  <g data-id="{box_id}" transform="translate({master_x:.2f} {master_y:.2f}) '
        f'scale({sx:.6f} {sy:.6f})" fill="none" stroke="black" stroke-width="2.5" '
        f'stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke">\n'
        f'{paths_svg}\n'
        f'  </g>\n'
        f'</svg>\n'
    )
    out = ROOT / f"public/lineart-svg/box-{box_id}-skel.svg"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg, encoding="utf-8")
    print(f"[3/{box_id}] skel -> {out.name}  ({len(simplified)} polylines)", flush=True)
    return out
