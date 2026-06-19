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
    # Prompt 100% FRANÇAIS : gagnant du banc d'essai A/B (10 variantes testées
    # sur la même image). Donne le trait le plus net « Cocteau/Matisse » ET la
    # meilleure adhérence au sujet nommé. Le sujet est saisi par l'auteur (en
    # français) ; on le délimite clairement et on exclut explicitement toute
    # autre personne/objet du crop (le cadre rectangulaire inclut souvent des
    # voisins qu'il ne faut PAS tracer).
    subj = subject.strip() if subject and subject.strip() else ""
    if subj:
        cible = (
            f"qui trace le contour de : « {subj} ». Identifie cette ou ces "
            f"personne(s) dans la photo et trace SEULEMENT elle(s)."
        )
        exclusion = (
            "CRUCIAL : ne trace PERSONNE NI RIEN D'AUTRE. S'il y a d'autres "
            "personnes dans l'image (au bord, au fond, ou juste à côté du sujet), "
            "des vendeurs, des mains qui ne sont pas celles du sujet, des "
            "mannequins, du mobilier, des vitrines, des sacs ou des produits, "
            "laisse-les 100% INTACTS — aucun trait magenta dessus, pas même un "
            "petit segment. Le trait magenta apparaît UNIQUEMENT sur le sujet "
            "nommé, sur rien d'autre dans toute l'image."
        )
    else:
        cible = (
            "qui trace le contour de la ou des personne(s) principale(s) de la photo."
        )
        exclusion = (
            "Ne trace QUE le ou les sujet(s) humain(s). Laisse le mobilier, les "
            "vitrines, les sacs, les produits et tout l'arrière-plan 100% intacts — "
            "aucun trait magenta dessus."
        )
    return (
        "Je t'envoie une photographie. DESSINE DIRECTEMENT PAR-DESSUS, sur les "
        "pixels existants. NE REDESSINE PAS la photo, ne la modifie pas, ne change "
        "ni les couleurs ni le cadrage.\n\n"
        f"Ajoute UNIQUEMENT un fin trait MAGENTA pur ({DRAW_COLOR_HEX}, RVB 255,0,255) "
        f"{cible} Pose le trait directement sur la photo, le long de la silhouette "
        "du corps (tête, épaules, bras, torse, mains, jambes, pieds), pile sur la "
        "frontière entre le corps et le fond, par-dessus les pixels existants.\n\n"
        f"{exclusion}\n\n"
        "STYLE : un SEUL trait continu, fin et régulier (~3-4 px de large), tracé "
        "sans lever le crayon, qui boucle et se croise. Dessin à la ligne unique "
        "style Picasso / Cocteau / Matisse. Courbes organiques fluides, beaucoup "
        "LAISSÉES OUVERTES, se terminant en l'air en effilés élégants. Magenta "
        "saturé pur uniquement, aucune autre couleur, aucun ombrage, aucun "
        "remplissage.\n\n"
        "EXCLUSIONS STRICTES : AUCUN détail de visage (ni yeux, ni bouche, ni nez). "
        "AUCUNE texture de vêtement, AUCUN pli, AUCUN bouton, AUCUN motif, AUCUN "
        "détail de cheveux. AUCUN hachurage.\n\n"
        "SORTIE : la photographie EXACTE et inchangée (couleurs, lumière, cadrage, "
        "position, échelle), avec SEULEMENT le trait magenta ajouté par-dessus, et "
        "ce trait ne couvre QUE le sujet nommé."
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

    # Sécurité : on efface l'éventuel line.png précédent (vestige d'une
    # régénération partielle).
    try: line_path.unlink(missing_ok=True)
    except OSError: pass

    raw = np.array(Image.open(raw_path).convert("RGB")).astype(np.int16)
    original_img = Image.open(original_path).convert("RGB")
    if original_img.size != (raw.shape[1], raw.shape[0]):
        original_img = original_img.resize((raw.shape[1], raw.shape[0]), Image.LANCZOS)
    original = np.array(original_img).astype(np.int16)

    # FILTRE MAGENTA STRICT à deux critères (restauré de 42b623f, perdu lors
    # du revert e2b655b). L'ancien filtre simple ne testait QUE le score signé
    # (diff R-G+B > seuil). Or gpt-image-2 re-render TOUTE l'image (ce n'est PAS
    # un overlay pixel-perfect) : des pixels NON-tracés (meubles, vitres, sol,
    # reflets) dérivent de quelques unités et passaient le seuil → bruit de
    # décor dans line.png, puis dans le squelette. On exige désormais :
    #   1. is_magenta_color : la couleur FINALE est proche du magenta pur
    #      (R élevé, G faible, B élevé) — élimine les dérives de teinte du décor.
    #   2. is_shifted_to_magenta : le pixel a EFFECTIVEMENT viré au magenta
    #      depuis l'original (R/B montés, G baissé) — ignore les pixels déjà
    #      magenta dans la photo d'origine.
    R, G, B = raw[..., 0], raw[..., 1], raw[..., 2]
    is_magenta_color = (
        (R > 180) & (G < 120) & (B > 180) & (R - G > 60) & (B - G > 60)
    )
    diff = raw - original
    is_shifted_to_magenta = (
        (diff[..., 0] > 30) & (diff[..., 1] < -10) & (diff[..., 2] > 30)
    )
    is_drawn = is_magenta_color & is_shifted_to_magenta

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
