"""Image B (subject + bokeh background) and image C (American shot) per box.

Each box has: id, x, y, w, h (master coords), aspect, subject.
Image B uses the SAME crop as the line-art (whole box region from master).
Image C is reframed from image B as a portrait (1024x1536).

Outputs:
  public/exp3/imageB/box-{id}.png
  public/exp3/imageC/box-{id}.png
"""
from __future__ import annotations

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


def make_imageB(box: dict) -> Path:
    box_id = str(box["id"])
    tw, th = _showcase_size_for_box(box)
    # Reuse the lineart's input crop (still PNG, kept as PNG because lineart
    # post-processes it via image differencing — needs lossless input).
    crop_path = ROOT / f"public/crops/box-{box_id}-input.png"
    if not crop_path.exists():
        raise RuntimeError(f"missing input crop {crop_path} — run lineart first")
    out = EXP3 / f"imageB/box-{box_id}.jpg"
    return gpt_edit(crop_path, prompt_b(box.get("subject", "")), out, f"{tw}x{th}", "medium")


def make_imageC(box: dict) -> Path:
    box_id = str(box["id"])
    # Image C is derived from image B; we look it up regardless of extension.
    b_path = EXP3 / f"imageB/box-{box_id}.jpg"
    if not b_path.exists():
        b_path = EXP3 / f"imageB/box-{box_id}.png"
    out = EXP3 / f"imageC/box-{box_id}.jpg"
    # Image C : portrait américain. On utilise le prompt_c personnalisé du
    # cadre s'il est fourni (panneau de cadre dans l'éditeur), sinon le prompt
    # par défaut (face caméra, expression chaleureuse).
    tw, th = snap_aspect(2, 3, target_pixels=SHOWCASE_TARGET_PIXELS)
    final_prompt = prompt_c(box.get("subject", ""), box.get("prompt_c"))
    return gpt_edit(b_path, final_prompt, out, f"{tw}x{th}", "medium")
