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

# pipeline/ est sur sys.path quand on est invoqué via server.py
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _size_utils import compute_gpt_crop, MIN_PIXELS, MAX_PIXELS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"
PUBLIC = ROOT / "public"
MASTER_PATH = PUBLIC / "master.jpg"

# Pour adoucir les bords de la zone éditée et garantir l'absence de jointure :
# floute le masque sur ~6 px avant le compositing.
FEATHER_RADIUS_PX = 6


def _validate_rect_user(rect: dict, master_w: int, master_h: int) -> dict:
    """Vérifie le rect USER (peut être plus petit que le min API — c'est OK,
    on l'élargit dans compute_gpt_crop)."""
    x, y, w, h = int(rect["x"]), int(rect["y"]), int(rect["w"]), int(rect["h"])
    if x < 0 or y < 0 or w <= 0 or h <= 0:
        raise ValueError(f"rect invalide : {rect}")
    if x + w > master_w or y + h > master_h:
        raise ValueError(f"rect dépasse le master : {rect}")
    if w % 16 or h % 16:
        raise ValueError(f"rect doit être multiple de 16 : {w}×{h}")
    if max(w, h) / max(1, min(w, h)) > 3.0:
        raise ValueError(f"ratio > 3:1 : {w}×{h}")
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
    """Pipeline complet. Renvoie le chemin du master mis à jour.

    Si le rect user est plus petit que le minimum gpt-image-2 (655 360 px),
    on étend automatiquement la zone envoyée à GPT en incluant du contexte
    master autour. Le mask GPT est étendu aussi : zones préservées partout
    sauf à l'intérieur du rect user où on copie le mask user. Au retour, on
    extrait juste la sous-zone correspondant au rect user → recollage propre
    dans le master sans toucher aux pixels qui ne devaient pas l'être.
    """
    if not MASTER_PATH.exists():
        raise RuntimeError(f"master introuvable : {MASTER_PATH}")
    master = Image.open(MASTER_PATH).convert("RGB")
    master_w, master_h = master.size
    rect = _validate_rect_user(rect, master_w, master_h)
    rx, ry, rw, rh = rect["x"], rect["y"], rect["w"], rect["h"]

    # 1. Calcule le crop ÉLARGI à envoyer à GPT (>= 655 360 px, valide API).
    gx, gy, gw, gh = compute_gpt_crop(rx, ry, rw, rh, master_w, master_h)
    rx_in_g, ry_in_g = rx - gx, ry - gy
    print(f"[char-edit] rect user=({rx},{ry},{rw}×{rh}) "
          f"-> gpt-crop=({gx},{gy},{gw}×{gh})", flush=True)

    # 2. Extract du master le crop élargi (pas de resize : déjà valide).
    big_crop = master.crop((gx, gy, gx + gw, gy + gh))

    # 3. Charge le mask user (alpha=0 = à éditer dans le rect user).
    user_mask = Image.open(mask_png_path).convert("RGBA")
    if user_mask.size != (rw, rh):
        user_mask = user_mask.resize((rw, rh), Image.NEAREST)

    # 4. Construit le mask GPT à la taille du crop élargi :
    #    - opaque PARTOUT (à préserver)
    #    - dans la sous-zone du rect user, on copie LE mask user tel quel
    #      (alpha=0 dans la zone à éditer, alpha=255 ailleurs dans le rect).
    #    ATTENTION : on paste SANS troisième argument, sinon PIL utilise
    #    user_mask comme mask de paste et ne transfère pas les pixels
    #    transparents (= la zone à éditer reste opaque dans big_mask et
    #    GPT préserve donc TOUT, ce qui donne l'impression que la
    #    génération est sans effet — bug observé en prod).
    big_mask = Image.new("RGBA", (gw, gh), (0, 0, 0, 255))
    big_mask.paste(user_mask, (rx_in_g, ry_in_g))

    # 5. Appel GPT
    with tempfile.TemporaryDirectory() as tmp:
        crop_path = Path(tmp) / "crop.png"
        mask_path = Path(tmp) / "mask.png"
        result_path_ = Path(tmp) / "result.png"
        big_crop.save(crop_path)
        big_mask.save(mask_path)
        size_str = f"{gw}x{gh}"
        print(f"[char-edit] GPT edit on {size_str}…", flush=True)
        actual = _gpt_inpaint(crop_path, mask_path, prompt, size_str, result_path_)
        gpt_result = Image.open(actual).convert("RGB")
        if gpt_result.size != (gw, gh):
            gpt_result = gpt_result.resize((gw, gh), Image.LANCZOS)

        # 6. Compositing sur le crop élargi : pixels édités où le user a peint,
        #    pixels strictement préservés ailleurs (grâce au mask élargi avec
        #    alpha=255 hors du rect user). Le mask passé pour le compositing
        #    est l'inverse alpha (255 = à éditer).
        edit_alpha_full = _invert_alpha_to_edit_mask(big_mask)
        composited_full = _composite(big_crop, gpt_result, edit_alpha_full)

    # 7. Extrait la sous-zone qui correspond au rect user — c'est la SEULE
    #    partie qu'on collera dans le master. La zone du contexte ajouté
    #    (hors rect user) est ignorée : on ne touche pas à ces pixels du master.
    sub = composited_full.crop((rx_in_g, ry_in_g, rx_in_g + rw, ry_in_g + rh))

    # 8. Recolle dans le master et sauve (JPEG q=85)
    master.paste(sub, (rx, ry))
    master.save(MASTER_PATH, "JPEG", quality=85, optimize=True)
    print(f"[char-edit] master mis à jour ({rx},{ry}, {rw}×{rh})", flush=True)
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
