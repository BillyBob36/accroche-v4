"""Helpers to map an arbitrary aspect ratio to a valid gpt-image-2 size.

gpt-image-2 constraints:
  - both edges multiple of 16
  - long edge <= 3840
  - aspect ratio <= 3:1
  - total pixels in [655_360, 8_294_400]
"""
from __future__ import annotations

# Hard constraints from the API
MIN_PIXELS = 655_360
MAX_PIXELS = 8_294_400
MAX_LONG = 3840
MAX_RATIO = 3.0
STEP = 16

# Project-level "mid-resolution" target used by exp3 / quest images.
# Lineart uses a smaller pool to keep post-processing fast.
DEFAULT_TARGET_PIXELS_HIGH = 2_000_000   # imageB / imageC / quest images
DEFAULT_TARGET_PIXELS_LOW  = 1_500_000   # lineart input


def _round16(v: float) -> int:
    n = round(v / STEP) * STEP
    return max(STEP, n)


def snap_aspect(aspect_w: float, aspect_h: float, *,
                target_pixels: int = DEFAULT_TARGET_PIXELS_HIGH,
                max_long: int = MAX_LONG) -> tuple[int, int]:
    """Compute a valid gpt-image-2 (W, H) that approximates the requested aspect ratio.

    Strategy:
      1. Compute the ideal (w, h) at exactly `target_pixels` for this aspect.
      2. Round each edge to the nearest multiple of 16.
      3. If the long edge exceeds `max_long`, downscale.
      4. Clamp the aspect ratio to MAX_RATIO (otherwise the API rejects it).
      5. If pixel count is below MIN_PIXELS, scale up; if above MAX_PIXELS, scale down.

    Always returns dimensions that satisfy ALL gpt-image-2 constraints.
    """
    if aspect_w <= 0 or aspect_h <= 0:
        return 1024, 1024

    # Clamp ratio to MAX_RATIO so the API accepts it.
    ratio_raw = aspect_w / aspect_h          # >1 = landscape, <1 = portrait
    sign = 1 if ratio_raw >= 1 else -1
    ratio = abs(ratio_raw) if ratio_raw >= 1 else 1.0 / abs(ratio_raw)
    if ratio > MAX_RATIO:
        ratio = MAX_RATIO
    if sign < 0:
        ratio = 1.0 / ratio

    # Ideal real-valued size at target_pixels.
    if ratio >= 1:
        h_exact = (target_pixels / ratio) ** 0.5
        w_exact = h_exact * ratio
    else:
        w_exact = (target_pixels * ratio) ** 0.5
        h_exact = w_exact / ratio

    # Cap the long edge first (so the rounded result stays within bounds).
    long_exact = max(w_exact, h_exact)
    if long_exact > max_long:
        scale = max_long / long_exact
        w_exact *= scale
        h_exact *= scale

    w = _round16(w_exact)
    h = _round16(h_exact)

    # Pixel-count guards. MIN/MAX_PIXELS are hard API constraints.
    pixels = w * h
    if pixels < MIN_PIXELS:
        # Scale up uniformly until we cross MIN_PIXELS, but stop at MAX_LONG.
        while w * h < MIN_PIXELS and max(w, h) + STEP <= max_long:
            w += STEP
            h = _round16(w / max(0.001, w / max(1, h)))  # keep ratio approximately
            # Use the original ratio rather than stale w/h:
            if ratio >= 1:
                h = _round16(w / ratio)
            else:
                h = _round16(w / ratio)
        # Fallback: if still too small, return the smallest valid square.
        if w * h < MIN_PIXELS:
            return 1024, 1024
    if pixels > MAX_PIXELS:
        scale = (MAX_PIXELS / pixels) ** 0.5
        w = _round16(w * scale)
        h = _round16(h * scale)

    # Final ratio guard (rounding may have nudged it just over).
    if max(w, h) / min(w, h) > MAX_RATIO:
        # Shrink the long edge.
        if w >= h:
            w = _round16(h * MAX_RATIO)
        else:
            h = _round16(w * MAX_RATIO)

    # Safety: ensure non-zero edges (shouldn't happen).
    w = max(STEP, w)
    h = max(STEP, h)
    return w, h


def snap_size_string(aspect_w: float, aspect_h: float, **kwargs) -> str:
    """Same as snap_aspect but returns 'WxH'."""
    w, h = snap_aspect(aspect_w, aspect_h, **kwargs)
    return f"{w}x{h}"


def compute_gpt_crop(rx: int, ry: int, rw: int, rh: int,
                     master_w: int, master_h: int,
                     min_pixels: int = MIN_PIXELS,
                     max_long: int = MAX_LONG) -> tuple[int, int, int, int]:
    """Calcule un crop master à envoyer à GPT, qui CONTIENT le rect logique
    `(rx, ry, rw, rh)` et qui respecte les contraintes gpt-image-2.

    Si `(rw, rh)` est déjà valide (≥ min_pixels, multiples de 16, etc.), on
    renvoie le rect tel quel. Sinon on ÉTEND autour du rect (en gardant le
    rect au centre quand possible) jusqu'à atteindre la taille minimum.

    Renvoie `(gx, gy, gw, gh)` : le crop à découper dans le master. Le rect
    logique se retrouvera à la position `(rx - gx, ry - gy, rw, rh)` dans le
    crop, ce qui permet d'extraire la sous-zone d'origine après inférence.
    """
    if rw < STEP or rh < STEP:
        rw = max(rw, STEP); rh = max(rh, STEP)

    # 1. On veut une taille (gw, gh) qui :
    #    - garde le ratio rw/rh
    #    - a gw*gh >= min_pixels
    #    - long edge <= max_long
    #    - ratio <= MAX_RATIO (3)
    ratio = rw / rh
    if ratio > MAX_RATIO:
        ratio = MAX_RATIO
        rw_eff = rh * MAX_RATIO
        rh_eff = rh
    elif 1 / ratio > MAX_RATIO:
        ratio = 1 / MAX_RATIO
        rw_eff = rw
        rh_eff = rw * MAX_RATIO
    else:
        rw_eff, rh_eff = rw, rh

    # Calcule le facteur d'agrandissement pour atteindre min_pixels exactement.
    needed = max(1.0, min_pixels / max(1, rw_eff * rh_eff))
    scale = needed ** 0.5
    gw = rw_eff * scale
    gh = rh_eff * scale

    # Cap long edge.
    long_edge = max(gw, gh)
    if long_edge > max_long:
        f = max_long / long_edge
        gw *= f; gh *= f

    # Cap par le master (le crop doit tenir dans le master).
    if gw > master_w:
        f = master_w / gw
        gw *= f; gh *= f
    if gh > master_h:
        f = master_h / gh
        gw *= f; gh *= f

    # Snap multiples de 16, vers le haut pour rester >= min_pixels.
    gw = max(STEP, ((int(round(gw)) + STEP - 1) // STEP) * STEP)
    gh = max(STEP, ((int(round(gh)) + STEP - 1) // STEP) * STEP)
    gw = min(gw, master_w - (master_w % STEP) if master_w % STEP else master_w)
    gh = min(gh, master_h - (master_h % STEP) if master_h % STEP else master_h)

    # Si le snap nous a remis juste sous min_pixels, on agrandit du côté qui a
    # le plus de marge dans le master.
    safety = 0
    while gw * gh < min_pixels and safety < 32:
        safety += 1
        margin_w = master_w - gw
        margin_h = master_h - gh
        if gw <= gh and margin_w >= STEP:
            gw += STEP
        elif margin_h >= STEP:
            gh += STEP
        elif margin_w >= STEP:
            gw += STEP
        else:
            break

    # 2. Position du crop : centre autour du rect logique, puis clamp.
    cx = rx + rw / 2
    cy = ry + rh / 2
    gx = int(round(cx - gw / 2))
    gy = int(round(cy - gh / 2))

    # Clamp dans le master, en gardant gw/gh constants. Snap de la position
    # à 16 px aussi (utile pour PIL.crop sur un crop d'image PIL — pas
    # vraiment requis, mais cohérent).
    gx = max(0, min(gx, master_w - gw))
    gy = max(0, min(gy, master_h - gh))

    # Si le rect logique dépasse encore les bords du crop (cas extrême : rect
    # collé contre un bord du master + crop élargi mais master petit), on
    # essaye d'aligner le crop sur le bord.
    if rx < gx:
        gx = max(0, rx)
    if ry < gy:
        gy = max(0, ry)
    if rx + rw > gx + gw:
        gx = max(0, min(master_w - gw, rx + rw - gw))
    if ry + rh > gy + gh:
        gy = max(0, min(master_h - gh, ry + rh - gh))

    return gx, gy, gw, gh


def parse_aspect_label(label: str) -> tuple[float, float] | None:
    """Parse a human-readable aspect ratio like '2:3' or '16:9'. Returns None
    for unknown labels (including 'free')."""
    if not label or ":" not in label:
        return None
    try:
        a, b = label.split(":", 1)
        w, h = float(a), float(b)
        if w > 0 and h > 0:
            return w, h
    except ValueError:
        pass
    return None
