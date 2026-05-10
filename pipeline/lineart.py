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
from _size_utils import snap_aspect, parse_aspect_label, compute_gpt_crop, MIN_PIXELS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"

# Lineart input pool: petit pour garder la skeletonization rapide.
LINEART_TARGET_PIXELS = 1_500_000
LINEART_MAX_LONG = 1536


def _gpt_crop_for_box(box: dict, master_w: int, master_h: int):
    """Calcule la zone master à envoyer à GPT pour ce box.
    Si le rect user est plus petit que le min API, étend autour.
    Renvoie (gx, gy, gw, gh, rx_in_g, ry_in_g) où (rx_in_g, ry_in_g) est la
    position du rect user à l'intérieur du crop GPT (en pixels)."""
    rx = int(round(float(box["x"])))
    ry = int(round(float(box["y"])))
    rw = int(round(float(box["w"])))
    rh = int(round(float(box["h"])))
    gx, gy, gw, gh = compute_gpt_crop(rx, ry, rw, rh, master_w, master_h)
    return gx, gy, gw, gh, rx - gx, ry - gy, rw, rh

# Drawing color — chosen to be unlikely to appear in boutique photos (no skin/cloth/wood
# is naturally pure magenta) so we can reliably detect it via image differencing.
DRAW_COLOR_HEX = "#FF00FF"
EXTRACT_THRESHOLD = 90  # min "magenta-shift score" for a pixel to count as drawn


def build_prompt(subject: str) -> str:
    target = subject.strip() if subject and subject.strip() else "the person(s) in this photograph"
    return (
        "I am sending you a photograph. Your task: DRAW DIRECTLY ON TOP of this exact "
        "photograph, ON the existing pixels. DO NOT redraw the photo. DO NOT modify, "
        "remove, or recolor anything in the photograph itself.\n\n"
        f"Add ONLY a thin pure MAGENTA ink line ({DRAW_COLOR_HEX}, RGB 255,0,255) "
        f"tracing the visible contour of: {target}.\n\n"
        f"==== STRICT SUBJECT RULE (NON-NEGOTIABLE) ====\n"
        f"You must trace ONLY the human silhouette of {target}. Trace the body outline "
        "ONLY: head, shoulders, arms, torso, hands, legs, feet. Pixel-for-pixel along "
        "the boundary between BODY and BACKGROUND.\n\n"
        "DO NOT trace ANY of the following, no matter how visible they are in the photo:\n"
        "  - Furniture (counters, tables, shelves, chairs, displays, vitrines, cabinets)\n"
        "  - Architecture (walls, doors, windows, ceilings, floors, staircases)\n"
        "  - Objects held (bags, bottles, boxes, jewelry, glasses, phones, papers)\n"
        "  - Decorative elements (plants, lamps, mirrors, signs, ornaments)\n"
        "  - Background patterns or shadows on walls/floor\n"
        "  - Other people who are NOT explicitly part of the subject described above\n\n"
        "If the subject mentions ONE person, trace ONLY that one person — IGNORE all\n"
        "other people. If the subject mentions a couple or group, trace ONLY those\n"
        "specific people. Furniture and objects in front of/behind the subject must\n"
        "REMAIN INVISIBLE in your tracing — your line must trace the body outline\n"
        "AS IF the subject were standing alone in empty space.\n\n"
        "STYLE: ONE uninterrupted thin uniform magenta line (~3-4 pixels wide), drawn "
        "without lifting the pen, looping back, crossing and overlapping itself. "
        "Picasso / Jean Cocteau / Henri Matisse single-line fashion sketch. Smooth "
        "flowing organic curves. Many curves LEFT OPEN, terminating mid-air in elegant "
        "tapers. Pure saturated magenta only — no other ink colors, no shading, no fill.\n\n"
        "STRICT EXCLUSIONS: NO facial features detail (no eyes, mouth, nose). NO clothing "
        "texture, NO fabric folds, NO buttons, NO patterns, NO hair strand details. "
        "NO hatching, NO halftone.\n\n"
        "OUTPUT: the EXACT same photograph with ONLY the magenta tracing line added on "
        "top. The photographic content underneath the line must remain 100% unchanged "
        "in color, lighting, framing, position, and scale."
    )


def extract_box_input(box: dict) -> tuple[Path, dict]:
    """Extrait du master un crop ÉLARGI (>= 655 360 px) qui contient le rect
    logique du user. Le rect user peut être tout petit ; le crop élargi
    permet de respecter les contraintes API gpt-image-2 sans déformer.

    Sauvegarde geom avec :
      - `crop_in_master`  : le rect user (zone qui sera utilisée dans le master)
      - `gpt_crop`        : le crop élargi envoyé à GPT
      - `rect_in_gpt`     : position du rect user dans le crop GPT
    """
    box_id = str(box["id"])
    aspect = box.get("aspect", "free")

    master_path = ROOT / "public/master.jpg"
    if not master_path.exists():
        master_path = ROOT / "public/master.png"
    master = Image.open(master_path).convert("RGB")
    master_w, master_h = master.size

    gx, gy, gw, gh, rx_in_g, ry_in_g, rw, rh = _gpt_crop_for_box(box, master_w, master_h)

    # Si le crop élargi dépasse encore la cible "lineart" en pixels (1.5M),
    # on resize le crop à la baisse en gardant le ratio. Sinon on utilise
    # la taille brute (déjà multiples de 16, déjà valide API).
    crop = master.crop((gx, gy, gx + gw, gy + gh))
    target_w, target_h = gw, gh
    if gw * gh > LINEART_TARGET_PIXELS or max(gw, gh) > LINEART_MAX_LONG:
        target_w, target_h = snap_aspect(
            gw, gh, target_pixels=LINEART_TARGET_PIXELS, max_long=LINEART_MAX_LONG
        )
        crop = crop.resize((target_w, target_h), Image.LANCZOS)

    # Échelle entre le crop master (gw, gh) et l'image envoyée à GPT.
    # Sert à reprojeter (rx_in_g, ry_in_g, rw, rh) dans l'espace GPT.
    sx = target_w / gw
    sy = target_h / gh
    rect_in_gpt = {
        "x": int(round(rx_in_g * sx)),
        "y": int(round(ry_in_g * sy)),
        "w": int(round(rw * sx)),
        "h": int(round(rh * sy)),
    }

    out = ROOT / f"public/crops/box-{box_id}-input.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out)
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(
            f"extract_box_input: failed to write {out} "
            f"(box id={box_id}, gpt_crop=({gx},{gy},{gw},{gh}), "
            f"target_size=({target_w}, {target_h}))"
        )

    geom = {
        "id": box_id,
        "subject": box.get("subject", ""),
        "aspect": aspect,
        # Le rect user — la zone qu'on placera dans le master à la fin.
        "crop_in_master": {"x": float(box["x"]), "y": float(box["y"]),
                           "w": float(box["w"]), "h": float(box["h"])},
        # Le crop élargi envoyé à GPT.
        "gpt_crop_in_master": {"x": gx, "y": gy, "w": gw, "h": gh},
        # Position du rect user dans le crop GPT (en pixels du crop, après resize).
        "rect_in_gpt": rect_in_gpt,
        "target_size": {"w": target_w, "h": target_h},
    }
    (out.parent / f"box-{box_id}-geom.json").write_text(
        json.dumps(geom, indent=2), encoding="utf-8"
    )
    print(f"[1/{box_id}] rect user=({int(box['x'])},{int(box['y'])},{int(box['w'])}x{int(box['h'])}) "
          f"-> gpt-crop=({gx},{gy},{gw}x{gh}) @ {target_w}x{target_h}", flush=True)
    return out, geom


def _load_geom(box_id: str) -> dict:
    p = ROOT / f"public/crops/box-{box_id}-geom.json"
    return json.loads(p.read_text(encoding="utf-8"))


def run_gpt_lineart(box: dict, crop_path: Path) -> Path:
    box_id = str(box["id"])
    # On lit la taille réelle de l'input crop (déjà multiples de 16, déjà
    # valide API grâce à compute_gpt_crop dans extract_box_input).
    if crop_path.exists():
        with Image.open(crop_path) as im:
            tw, th = im.size
    else:
        tw, th = 1024, 1024  # fallback (jamais censé arriver)

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

    h_full, w_full = is_drawn.shape
    out_full = np.full((h_full, w_full), 255, dtype=np.uint8)
    out_full[is_drawn] = 0

    # Si le geom contient `rect_in_gpt`, on extrait la sous-zone qui
    # correspond au rect user — c'est ce qui sera squelettisé. Le contour
    # GPT en dehors du rect user est ignoré (c'est du contexte ajouté pour
    # respecter la taille minimum de l'API, pas le sujet utile).
    geom = _load_geom(box_id)
    rig = geom.get("rect_in_gpt")
    if rig and rig.get("w") and rig.get("h"):
        x1, y1 = rig["x"], rig["y"]
        x2, y2 = x1 + rig["w"], y1 + rig["h"]
        x1 = max(0, min(w_full, x1)); x2 = max(0, min(w_full, x2))
        y1 = max(0, min(h_full, y1)); y2 = max(0, min(h_full, y2))
        out = out_full[y1:y2, x1:x2]
    else:
        out = out_full
    Image.fromarray(out, "L").save(line_path)
    drawn = int((out == 0).sum())
    pct = drawn / max(1, out.size) * 100
    print(f"[2.5/{box_id}] extracted {drawn} drawn px ({pct:.2f}%) "
          f"in rect {out.shape[1]}x{out.shape[0]} -> {line_path.name}", flush=True)
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
