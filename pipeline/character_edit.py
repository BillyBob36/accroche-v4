"""Édition d'une zone du master via masque GPT (mode "Personnages").

Workflow :
  1. Reçoit (x, y, w, h) en coords master + un PNG de masque (transparent =
     à éditer, opaque = à préserver) à la taille (w, h) + un prompt.
  2. Extrait le crop correspondant du master.jpg sans redimensionnement.
  3. Appelle gpt-image-2 edit avec image=crop, mask=mask, prompt.
  4. Reçoit le résultat (même taille).
  5. Composite : final = original × (1 - mask_blurred) + résultat × mask_blurred
     où `mask_blurred` est le mask flouté (feather) pour transition douce.
     Hors zone peinte, mask_blurred ≈ 0 → pixels strictement identiques à
     l'original → recollage invisible dans le master.
  6. Colle final dans master.jpg à (x, y) et sauve.

Usage (CLI / via subprocess depuis server.py) :
  - PARAMS via env :
      ACCROCHE_CHAR_RECT  = JSON {"x":int,"y":int,"w":int,"h":int}
      ACCROCHE_CHAR_PROMPT = string
      ACCROCHE_CHAR_MASK_PATH = chemin du PNG de masque (alpha=0 = à éditer)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"
PUBLIC = ROOT / "public"
MASTER_PATH = PUBLIC / "master.jpg"

# Pour adoucir les bords de la zone éditée et garantir l'absence de jointure :
# floute le masque sur ~6 px avant le compositing.
FEATHER_RADIUS_PX = 6


def _validate_rect(rect: dict, master_w: int, master_h: int) -> dict:
    """Vérifie que (x, y, w, h) respecte les contraintes gpt-image-2."""
    x, y, w, h = int(rect["x"]), int(rect["y"]), int(rect["w"]), int(rect["h"])
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        raise ValueError(f"rect invalide : {rect}")
    if x + w > master_w or y + h > master_h:
        raise ValueError(f"rect dépasse le master : {rect}")
    if w % 16 or h % 16:
        raise ValueError(f"rect doit être multiple de 16 : {w}×{h}")
    if max(w, h) > 3840:
        raise ValueError(f"long edge trop grand : {max(w, h)}")
    if max(w, h) / min(w, h) > 3.0:
        raise ValueError(f"ratio > 3:1 : {w}×{h}")
    px = w * h
    if px < 655_360:
        raise ValueError(f"trop peu de pixels ({px} < 655360). Agrandis le cadre.")
    if px > 8_294_400:
        raise ValueError(f"trop de pixels ({px} > 8294400). Réduis le cadre.")
    return {"x": x, "y": y, "w": w, "h": h}


def _gpt_inpaint(image_path: Path, mask_path: Path, prompt: str,
                 size: str, out_path: Path) -> Path:
    """Lance le edit endpoint avec --image et --mask. Renvoie le chemin du résultat."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Wipe stale outputs avec le même stem
    for ext in ("png", "jpg", "jpeg", "webp"):
        for stale in out_path.parent.glob(f"{out_path.stem}*.{ext}"):
            try: stale.unlink()
            except OSError: pass
    cmd = [
        sys.executable, str(EDIT_SCRIPT),
        "--image", str(image_path),
        "--mask", str(mask_path),
        "--prompt", prompt,
        "--output", str(out_path),
        "--size", size,
        "--quality", "medium",
        "--format", "png",   # PNG pour préserver la finesse pour le compositing
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"edit.py failed: {res.stderr.strip()[:600]}")
    return Path(res.stdout.strip().splitlines()[-1])


def _composite(original_crop: Image.Image, gpt_result: Image.Image,
               mask_for_edit: Image.Image) -> Image.Image:
    """Mélange GPT (zones à éditer) avec l'original (zones préservées).

    `mask_for_edit` : alpha=255 sur les pixels à ÉDITER (donc l'inverse du mask
    envoyé à GPT, qui suit la convention « transparent = à éditer »).
    """
    if original_crop.size != gpt_result.size or original_crop.size != mask_for_edit.size:
        raise ValueError(
            f"tailles incompatibles : original {original_crop.size}, "
            f"GPT {gpt_result.size}, mask {mask_for_edit.size}"
        )
    # Floute légèrement le masque pour adoucir les transitions et masquer les
    # éventuels micro-écarts de couleur que GPT aurait introduits aux bords.
    mask_blurred = mask_for_edit.filter(ImageFilter.GaussianBlur(radius=FEATHER_RADIUS_PX))
    # Composite via PIL.Image.composite — utilise l'alpha du mask flouté
    # comme poids du résultat GPT.
    return Image.composite(gpt_result.convert("RGB"),
                           original_crop.convert("RGB"),
                           mask_blurred.convert("L"))


def _invert_alpha_to_edit_mask(mask_png: Image.Image) -> Image.Image:
    """Le masque envoyé par le front a alpha=0 sur les zones à éditer.
    Pour le compositing on a besoin de l'inverse (alpha=255 où à éditer)."""
    arr = np.array(mask_png.convert("RGBA"))
    edit_alpha = 255 - arr[:, :, 3]   # invert
    out = np.zeros_like(arr)
    out[:, :, 3] = edit_alpha
    return Image.fromarray(out, "RGBA").split()[-1].convert("L")


def edit_master_zone(rect: dict, mask_png_path: Path, prompt: str) -> Path:
    """Pipeline complet. Renvoie le chemin du master mis à jour."""
    if not MASTER_PATH.exists():
        raise RuntimeError(f"master introuvable : {MASTER_PATH}")
    master = Image.open(MASTER_PATH).convert("RGB")
    rect = _validate_rect(rect, *master.size)
    x, y, w, h = rect["x"], rect["y"], rect["w"], rect["h"]

    # 1. Extract le crop (sans resize : tailles déjà multiples de 16)
    crop = master.crop((x, y, x + w, y + h))

    # 2. Charge et vérifie le masque
    mask = Image.open(mask_png_path).convert("RGBA")
    if mask.size != (w, h):
        # Le front l'a normalement créé à la bonne taille ; sinon on resize.
        mask = mask.resize((w, h), Image.NEAREST)

    # 3. Appel GPT
    with tempfile.TemporaryDirectory() as tmp:
        crop_path = Path(tmp) / "crop.png"
        gpt_mask_path = Path(tmp) / "mask.png"
        gpt_out_path = Path(tmp) / "result.png"
        crop.save(crop_path)
        mask.save(gpt_mask_path)
        size_str = f"{w}x{h}"
        print(f"[char-edit] GPT edit on {size_str} crop at ({x},{y})…", flush=True)
        result_path = _gpt_inpaint(crop_path, gpt_mask_path, prompt, size_str, gpt_out_path)
        gpt_result = Image.open(result_path).convert("RGB")
        if gpt_result.size != (w, h):
            gpt_result = gpt_result.resize((w, h), Image.LANCZOS)

        # 4. Compositing : ne change que la zone peinte par l'utilisateur
        edit_alpha_mask = _invert_alpha_to_edit_mask(mask)
        composited = _composite(crop, gpt_result, edit_alpha_mask)

    # 5. Recolle dans le master et sauve (JPEG q=85)
    master.paste(composited, (x, y))
    master.save(MASTER_PATH, "JPEG", quality=85, optimize=True)
    print(f"[char-edit] master mis à jour ({x},{y}, {w}×{h})", flush=True)
    return MASTER_PATH


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rect", help="JSON {x,y,w,h}")
    ap.add_argument("--mask", help="chemin du PNG masque")
    ap.add_argument("--prompt", help="prompt GPT")
    args = ap.parse_args()

    rect_json = args.rect or os.environ.get("ACCROCHE_CHAR_RECT") or ""
    mask_path = args.mask or os.environ.get("ACCROCHE_CHAR_MASK_PATH") or ""
    prompt = args.prompt or os.environ.get("ACCROCHE_CHAR_PROMPT") or ""
    if not rect_json or not mask_path or not prompt:
        print("missing rect / mask / prompt", file=sys.stderr)
        return 2
    try:
        rect = json.loads(rect_json)
        out = edit_master_zone(rect, Path(mask_path), prompt)
        print(str(out))
        return 0
    except Exception as e:
        print(f"!! {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
