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
