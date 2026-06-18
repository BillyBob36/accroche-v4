"""Generate the one-line ink sketch for a user-drawn box.

Strategy: ask gpt-image-2 to TRACE the subject directly ON the input photograph
in pure magenta (#FF00FF) ink. We then subtract the original photo from the
output and keep only the pixels that shifted toward magenta — that gives us a
clean line-art aligned pixel-for-pixel with the photographed subject (no GPT
margin/centering issues, since the photo underneath anchors the line).

Each box dict has: id, x, y, w, h (master coords), aspect ('1:1'|'2:3'|'3:2'),
subject (free text describing what to draw, e.g. 'the woman in red dress').

Outputs:
  public/crops/box-{id}-input.png   master crop sent to GPT
  public/crops/box-{id}-raw.png     GPT output: photo + magenta tracing
  public/crops/box-{id}-line.png    extracted lines on white (skeletonize input)
  public/crops/box-{id}-geom.json
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# pipeline/ is on sys.path when invoked through full.py / regen_box.py / server.py
from _size_utils import snap_aspect, parse_aspect_label  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"

# Lineart input pool: smaller resolution to keep skeleton post-processing fast.
LINEART_TARGET_PIXELS = 1_500_000
LINEART_MAX_LONG = 1536


def _lineart_size_for_box(box: dict) -> tuple[int, int]:
    """Pick a valid gpt-image-2 size from the box's actual aspect.

    Uses the box's real w/h (so 'free'-form boxes work too). Falls back to the
    aspect label only if w/h is missing.
    """
    w = float(box.get("w") or 0)
    h = float(box.get("h") or 0)
    if w <= 0 or h <= 0:
        parsed = parse_aspect_label(box.get("aspect", "")) or (2, 3)
        w, h = parsed
    return snap_aspect(w, h, target_pixels=LINEART_TARGET_PIXELS,
                       max_long=LINEART_MAX_LONG)

# Drawing color — chosen to be unlikely to appear in boutique photos (no skin/cloth/wood
# is naturally pure magenta) so we can reliably detect it via image differencing.
DRAW_COLOR_HEX = "#FF00FF"
EXTRACT_THRESHOLD = 90  # min "magenta-shift score" for a pixel to count as drawn


def build_prompt(subject: str) -> str:
    subj = subject.strip() if subject and subject.strip() else ""
    if subj:
        # Le sujet est saisi par l'auteur, souvent en FRANÇAIS. On le délimite
        # clairement et on insiste : tracer UNIQUEMENT ce sujet, et laisser
        # toute autre personne/objet du cadre intact (le cadre rectangulaire
        # inclut souvent des personnes voisines qu'il ne faut PAS tracer).
        target_clause = (
            f'tracing the visible contour of ONLY this specific subject (description '
            f'may be in French): « {subj} ». Identify the matching person(s) in the '
            f'photograph and trace ONLY them.'
        )
        exclusion_block = (
            "CRITICAL — TRACE ONLY THE NAMED SUBJECT ABOVE, NOBODY ELSE.\n"
            "If the photograph contains OTHER people (e.g. someone standing at the "
            "edge, in the background, or beside the subject), salespeople, hands that "
            "do not belong to the subject, mannequins, furniture, glass display cases, "
            "handbags, products, or ANY element that is NOT part of the named subject, "
            "you MUST leave them 100% UNTOUCHED — absolutely NO magenta line on them, "
            "not even a small segment. The magenta line appears on the named subject "
            "and on NOTHING ELSE in the entire image.\n\n"
        )
    else:
        target_clause = (
            "tracing the visible contour of the main human subject(s) in this photograph"
        )
        exclusion_block = (
            "Trace ONLY the human subject(s). Leave furniture, glass display cases, "
            "handbags, products and all background objects 100% untouched — no magenta "
            "line on them.\n\n"
        )
    return (
        "I am sending you a photograph. Your task: DRAW DIRECTLY ON TOP of this exact "
        "photograph, ON the existing pixels. DO NOT redraw the photo. DO NOT modify, "
        "remove, or recolor anything in the photograph itself.\n\n"
        f"Add ONLY a thin pure MAGENTA ink line ({DRAW_COLOR_HEX}, RGB 255,0,255) "
        f"{target_clause} Place the line directly on the "
        "photograph, exactly along the body silhouette — head, shoulders, arms, torso, "
        "hands, legs, feet — pixel-for-pixel along the boundary between body and "
        "background, sitting on top of the existing photographic pixels.\n\n"
        + exclusion_block +
        "STYLE: ONE uninterrupted thin uniform magenta line (~3-4 pixels wide), drawn "
        "without lifting the pen, looping back, crossing and overlapping itself. "
        "Picasso / Jean Cocteau / Henri Matisse single-line fashion sketch. Smooth "
        "flowing organic curves. Many curves LEFT OPEN, terminating mid-air in elegant "
        "tapers. Pure saturated magenta only — no other ink colors, no shading, no fill.\n\n"
        "STRICT EXCLUSIONS: NO facial features detail (no eyes, mouth, nose). NO clothing "
        "texture, NO fabric folds, NO buttons, NO patterns, NO hair strand details. "
        "NO hatching, NO halftone.\n\n"
        "OUTPUT: the EXACT same photograph with ONLY the magenta tracing line added on "
        "top (and the line must cover ONLY the named subject). The photographic content "
        "underneath the line must remain 100% unchanged in color, lighting, framing, "
        "position, and scale."
    )


def extract_box_input(box: dict) -> tuple[Path, dict]:
    bx, by = float(box["x"]), float(box["y"])
    bw, bh = float(box["w"]), float(box["h"])
    aspect = box.get("aspect", "2:3")
    target_w, target_h = _lineart_size_for_box(box)

    # Master may be JPEG (default) or PNG (legacy / pre-conversion).
    master_path = ROOT / "public/master.jpg"
    if not master_path.exists():
        master_path = ROOT / "public/master.png"
    master = Image.open(master_path).convert("RGB")
    crop = master.crop((bx, by, bx + bw, by + bh)).resize((target_w, target_h), Image.LANCZOS)

    box_id = str(box["id"])
    out = ROOT / f"public/crops/box-{box_id}-input.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(
            f"extract_box_input: failed to write {out} "
            f"(box id={box_id}, master_crop={(bx, by, bw, bh)}, "
            f"target_size=({target_w}, {target_h}))"
        )

    geom = {
        "id": box_id,
        "subject": box.get("subject", ""),
        "aspect": aspect,
        "crop_in_master": {"x": round(bx, 2), "y": round(by, 2),
                           "w": round(bw, 2), "h": round(bh, 2)},
        "target_size": {"w": target_w, "h": target_h},
    }
    (out.parent / f"box-{box_id}-geom.json").write_text(
        json.dumps(geom, indent=2), encoding="utf-8"
    )
    print(f"[1/{box_id}] crop ({int(bx)},{int(by)}, {int(bw)}x{int(bh)}) -> {target_w}x{target_h}", flush=True)
    return out, geom


def run_gpt_lineart(box: dict, crop_path: Path) -> Path:
    box_id = str(box["id"])
    tw, th = _lineart_size_for_box(box)

    if not crop_path.exists():
        raise RuntimeError(
            f"run_gpt_lineart: missing input crop {crop_path} for box id={box_id} "
            f"— extract_box_input must run first (or it failed silently)"
        )

    out = ROOT / f"public/crops/box-{box_id}-raw.png"
    for stale in out.parent.glob(f"box-{box_id}-raw*.png"):
        stale.unlink()

    cmd = [
        sys.executable, str(EDIT_SCRIPT),
        "--image", str(crop_path),
        "--prompt", build_prompt(box.get("subject", "")),
        "--output", str(out),
        "--size", f"{tw}x{th}",
        "--quality", "medium",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"edit.py box-{box_id}: {res.stderr}")
    actual = Path(res.stdout.strip().splitlines()[-1])
    print(f"[2/{box_id}] raw photo+magenta -> {actual.name}", flush=True)
    return actual


def extract_lines_from_overlay(box: dict) -> Path:
    """Subtract the original photo from the GPT output and keep magenta-shifted pixels.

    Output: a grayscale PNG where drawn pixels are dark (0) and the rest are white (255),
    matching the format expected by skeletonize_lineart.
    """
    box_id = str(box["id"])
    raw_path = ROOT / f"public/crops/box-{box_id}-raw.png"
    original_path = ROOT / f"public/crops/box-{box_id}-input.png"
    line_path = ROOT / f"public/crops/box-{box_id}-line.png"

    if not raw_path.exists():
        raise RuntimeError(
            f"extract_lines_from_overlay: missing GPT raw output {raw_path} "
            f"(box id={box_id}) — lineart GPT must run first"
        )
    if not original_path.exists():
        raise RuntimeError(
            f"extract_lines_from_overlay: missing input crop {original_path} "
            f"(box id={box_id}) — extract_box_input must run first or was wiped"
        )

    raw = np.array(Image.open(raw_path).convert("RGB")).astype(np.int16)
    original_img = Image.open(original_path).convert("RGB")
    if original_img.size != (raw.shape[1], raw.shape[0]):
        original_img = original_img.resize((raw.shape[1], raw.shape[0]), Image.LANCZOS)
    original = np.array(original_img).astype(np.int16)

    diff = raw - original                     # per-channel signed shift
    score = diff[..., 0] - diff[..., 1] + diff[..., 2]  # shift toward (255,0,255)
    is_drawn = score > EXTRACT_THRESHOLD

    h, w = is_drawn.shape
    out = np.full((h, w), 255, dtype=np.uint8)
    out[is_drawn] = 0
    Image.fromarray(out, "L").save(line_path)
    drawn = int(is_drawn.sum())
    pct = drawn / is_drawn.size * 100
    print(f"[2.5/{box_id}] extracted {drawn} drawn px ({pct:.2f}%) -> {line_path.name}", flush=True)
    return line_path


def run_one(box: dict) -> None:
    crop, _ = extract_box_input(box)
    run_gpt_lineart(box, crop)
    extract_lines_from_overlay(box)


def run_gpt_only(box: dict) -> None:
    """Assumes the input crop already exists. Runs GPT then post-extracts the lines."""
    box_id = str(box["id"])
    crop_path = ROOT / f"public/crops/box-{box_id}-input.png"
    run_gpt_lineart(box, crop_path)
    extract_lines_from_overlay(box)
