"""Image B (subject + bokeh background) and image C (American shot) per box.

Each box has: id, x, y, w, h (master coords), aspect, subject.
Image B uses the SAME crop as the line-art (whole box region from master).
Image C is reframed from image B as a portrait (1024x1536).

Outputs:
  public/exp3/imageB/box-{id}.png
  public/exp3/imageC/box-{id}.png
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

from _size_utils import snap_aspect, parse_aspect_label

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"
EXP3 = ROOT / "public/exp3"

# Mid-resolution target (~half of the gpt-image-2 cap). The actual W/H is
# computed from the box's real w/h so any aspect ratio works.
SHOWCASE_TARGET_PIXELS = 2_000_000


def _showcase_size_for_box(box: dict) -> tuple[int, int]:
    """Pick a valid gpt-image-2 size from the box's actual aspect."""
    w = float(box.get("w") or 0)
    h = float(box.get("h") or 0)
    if w <= 0 or h <= 0:
        parsed = parse_aspect_label(box.get("aspect", "")) or (2, 3)
        w, h = parsed
    return snap_aspect(w, h, target_pixels=SHOWCASE_TARGET_PIXELS)


def _is_moderation_blocked(stderr: str) -> bool:
    s = (stderr or "").lower()
    return "moderation_blocked" in s or "rejected by the safety system" in s


def _soften_prompt(prompt: str) -> str:
    p = (prompt or "").strip()
    replacements = (
        ("Same exact photograph.", "Use the input photo as reference."),
        ("EXACT same photograph", "same scene"),
        ("pixel-identical", "consistent"),
        ("Preserve identity exactly", "Keep the same person and overall appearance"),
        ("same exact pose(s)", "similar pose"),
        ("same age (~65)", "similar apparent age"),
        ("same age (~28)", "similar apparent age"),
        ("DO NOT modify anyone else.", "Keep other people and background natural and coherent."),
        ("DO NOT modify them in any way.", "Keep the person natural and recognizable."),
        ("ONLY change the BACKGROUND:", "Main change: background depth and blur."),
    )
    for src, dst in replacements:
        p = p.replace(src, dst)
    return p + " Keep all content appropriate and non-graphic."


def prompt_b(subject: str) -> str:
    target = subject.strip() if subject and subject.strip() else "the central person(s)"
    return (
        f"Same exact photograph. {target.capitalize()} must remain pixel-identical to the "
        "input: same face(s), same exact pose(s), same clothing details, same lighting, same "
        "expression(s). DO NOT modify them in any way. ONLY change the BACKGROUND: smoothly "
        "blur all background elements (shelves, bags, walls, floor, plants, windows, any "
        f"other people not part of {target}) with strong portrait-lens shallow depth of field, "
        "rendering them as soft creamy out-of-focus bokeh. Sharp focus on the subject. "
        "Photorealistic, high resolution, magazine-quality fashion editorial portrait. "
        "Maintain the same composition, framing, color grading. No watermark, no text, no logos."
    )


def prompt_c_default(subject: str) -> str:
    """Prompt par défaut pour image C (zoom face caméra) quand le cadre n'a
    pas de prompt_c personnalisé."""
    target = subject.strip() if subject and subject.strip() else "the person(s)"
    return (
        f"Reframe {target} as an American shot (medium shot, framed from mid-thigh up to "
        "slightly above the head). The subject(s) must face the camera DIRECTLY with friendly "
        "approachable eye contact, ready to engage in conversation with the viewer. Slight "
        "natural body turn, relaxed but engaged posture, subtle warm smile or open expression. "
        "Preserve identity exactly: same face(s), same age(s), same hair, same gender, same "
        "skin tone, same clothing style and color. Match the lighting and creamy bokeh "
        "background style from the input image. Setting: same softly blurred boutique "
        "atmosphere, warm golden ambient light, shallow depth of field. Photorealistic, "
        "high resolution, magazine-quality editorial portrait. Vertical portrait framing "
        "showing the upper body. No watermark, no text, no logos."
    )


# Suffixe ajouté à un prompt_c personnalisé pour préserver l'identité et le style
# graphique commun à l'ensemble des images du module.
_PROMPT_C_GUARDRAILS = (
    " Preserve identity exactly: same face, same hair, same skin tone, same clothing"
    " style and color. Match the lighting and creamy bokeh background style from the"
    " input image. Photorealistic, high resolution, magazine-quality editorial portrait."
    " Vertical portrait framing. No watermark, no text, no logos."
)


def prompt_c(subject: str, custom: str | None = None) -> str:
    """Renvoie le prompt à utiliser pour image C.
       Si `custom` est non vide, on l'utilise (avec un guardrail final pour
       garder l'identité + le style). Sinon prompt par défaut."""
    if custom and custom.strip():
        c = custom.strip()
        target = subject.strip() if subject and subject.strip() else None
        prefix = f"Reframe {target}: " if target else ""
        return prefix + c + _PROMPT_C_GUARDRAILS
    return prompt_c_default(subject)


def gpt_edit(image_path: Path, prompt: str, output_path: Path,
             size: str, quality: str = "medium") -> Path:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Wipe any stale outputs (PNG or JPG) under this name.
    for ext in ("png", "jpg", "jpeg"):
        for stale in output_path.parent.glob(f"{output_path.stem}*.{ext}"):
            stale.unlink()
    cmd = [
        sys.executable, str(EDIT_SCRIPT),
        "--image", str(image_path),
        "--prompt", prompt,
        "--output", str(output_path),
        "--size", size,
        "--quality", quality,
        "--format", "jpeg",
        # NB: edit.py (unlike generate.py) doesn't accept --compression — the
        # API uses its default JPEG compression which is already tight.
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0 and _is_moderation_blocked(res.stderr):
        safe_prompt = _soften_prompt(prompt)
        retry_cmd = [
            sys.executable, str(EDIT_SCRIPT),
            "--image", str(image_path),
            "--prompt", safe_prompt,
            "--output", str(output_path),
            "--size", size,
            "--quality", "low",
            "--format", "jpeg",
        ]
        res = subprocess.run(retry_cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"edit.py {output_path.name}: {res.stderr}")
    return Path(res.stdout.strip().splitlines()[-1])


def _load_geom(box_id: str) -> dict:
    p = ROOT / f"public/crops/box-{box_id}-geom.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _extract_rect_subimage(full_img_path: Path, box_id: str) -> Image.Image | None:
    """Si le geom contient `rect_in_gpt`, extrait du résultat GPT la sous-zone
    correspondant au rect user. Sinon renvoie None (on garde l'image entière)."""
    geom = _load_geom(box_id)
    rig = geom.get("rect_in_gpt")
    if not rig or not rig.get("w") or not rig.get("h"):
        return None
    full = Image.open(full_img_path).convert("RGB")
    fw, fh = full.size
    # Le geom a été calculé pour le crop input ; si GPT renvoie une taille
    # différente, on rescale la position au prorata.
    geom_w = (geom.get("target_size") or {}).get("w") or fw
    geom_h = (geom.get("target_size") or {}).get("h") or fh
    sx = fw / geom_w
    sy = fh / geom_h
    x1 = max(0, int(round(rig["x"] * sx)))
    y1 = max(0, int(round(rig["y"] * sy)))
    x2 = min(fw, int(round((rig["x"] + rig["w"]) * sx)))
    y2 = min(fh, int(round((rig["y"] + rig["h"]) * sy)))
    if x2 <= x1 or y2 <= y1:
        return None
    return full.crop((x1, y1, x2, y2))


def make_imageB(box: dict) -> Path:
    box_id = str(box["id"])
    crop_path = ROOT / f"public/crops/box-{box_id}-input.png"
    if not crop_path.exists():
        raise RuntimeError(f"missing input crop {crop_path} — run lineart first")
    # On envoie le crop ÉLARGI à GPT (taille déjà valide API, calculée par
    # extract_box_input via compute_gpt_crop). Pas besoin de spécifier la
    # taille manuellement — on lit celle du fichier.
    with Image.open(crop_path) as im:
        tw, th = im.size
    # Sortie temporaire (pleine taille GPT)
    raw_out = EXP3 / f"imageB/box-{box_id}-raw.jpg"
    gpt_edit(crop_path, prompt_b(box.get("subject", "")),
             raw_out, f"{tw}x{th}", "medium")
    # Extrait la sous-zone qui correspond au rect user (logique).
    final_out = EXP3 / f"imageB/box-{box_id}.jpg"
    sub = _extract_rect_subimage(raw_out, box_id)
    if sub is not None:
        final_out.parent.mkdir(parents=True, exist_ok=True)
        sub.save(final_out, "JPEG", quality=88, optimize=True)
        try: raw_out.unlink()
        except OSError: pass
    else:
        # Pas de geom / pas de sous-zone : on garde l'image GPT telle quelle.
        raw_out.rename(final_out)
    return final_out


def make_imageC(box: dict) -> Path:
    box_id = str(box["id"])
    # Image C est dérivée d'image B (qui est maintenant à la taille du rect
    # user, potentiellement < min API). On va donc étendre encore via
    # compute_gpt_crop pour que l'input soit valide pour GPT, puis ré-extraire
    # à la fin. Mais comme image B est déjà JPEG sans contexte master autour,
    # on adopte une approche plus simple : on UPSCALE image B au minimum API,
    # on demande à GPT de reframe en 2:3, on garde la sortie à la taille 2:3
    # (qui sera intrinsèquement >= min API).
    b_path = EXP3 / f"imageB/box-{box_id}.jpg"
    if not b_path.exists():
        b_path = EXP3 / f"imageB/box-{box_id}.png"
    if not b_path.exists():
        raise RuntimeError(f"missing imageB for box {box_id}")

    out = EXP3 / f"imageC/box-{box_id}.jpg"
    # Si imageB est trop petite pour l'API, on l'upscale Lanczos vers la
    # taille 2:3 cible. GPT accepte l'image upscalée comme input.
    target_w, target_h = snap_aspect(2, 3, target_pixels=SHOWCASE_TARGET_PIXELS)
    with Image.open(b_path) as bim:
        bw, bh = bim.size
        if bw * bh < SHOWCASE_TARGET_PIXELS // 2 or max(bw, bh) < 800:
            # Upscale d'abord pour donner à GPT plus de matière
            tmp_path = EXP3 / f"imageB/box-{box_id}-up.png"
            bim.resize((target_w, target_h), Image.LANCZOS).save(tmp_path)
            input_for_c = tmp_path
        else:
            input_for_c = b_path

    final_prompt = prompt_c(box.get("subject", ""), box.get("prompt_c"))
    res = gpt_edit(input_for_c, final_prompt, out, f"{target_w}x{target_h}", "medium")
    # Cleanup éventuel du fichier d'upscale
    if input_for_c != b_path:
        try: input_for_c.unlink()
        except OSError: pass
    return res
