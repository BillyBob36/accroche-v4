"""Generate quest images for a saved scene's quest.

A quest is attached to a box. We start from the existing box images:
  - imageB (subject + bokeh) is the basis for image1 (context + added element/scene change)
  - imageC (American shot, face-camera) is the basis for image2 (POV / expression change)

Inputs (read from public/scenes/<scene_id>/meta.json):
  quest = {
    id, box_id, title,
    image1_prompt,    # GPT prompt to derive image1 from imageB
    image2_prompt,    # GPT prompt to derive image2 from imageC
  }

Outputs:
  public/scenes/<scene_id>/quests/<qid>/image1.jpg
  public/scenes/<scene_id>/quests/<qid>/image2.jpg

Usage:
  python pipeline/quest_gen.py --scene <scene_id> --quest <quest_id>
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _size_utils import snap_aspect, parse_aspect_label  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
EDIT_SCRIPT = Path(__file__).resolve().parent / "_imagegen" / "edit.py"
SCENES = ROOT / "public" / "scenes"

QUEST_TARGET_PIXELS = 2_000_000


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
        ("same age (~65)", "similar apparent age"),
        ("same age (~28)", "similar apparent age"),
        ("DO NOT modify anyone else.", "Keep other people and background natural and coherent."),
        ("ONLY MODIFICATION:", "Primary change:"),
        ("No watermark, no text, no logos.", "No text overlays or logos."),
    )
    for src, dst in replacements:
        p = p.replace(src, dst)
    return p + " Keep all content appropriate and non-graphic."


def _gpt_edit(image_in: Path, prompt: str, out: Path, size: str = "1152x1728",
              quality: str = "medium") -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    for ext in ("png", "jpg", "jpeg", "webp"):
        for stale in out.parent.glob(f"{out.stem}*.{ext}"):
            try: stale.unlink()
            except OSError: pass
    cmd = [
        sys.executable, str(EDIT_SCRIPT),
        "--image", str(image_in),
        "--prompt", prompt,
        "--output", str(out),
        "--size", size,
        "--quality", quality,
        "--format", "jpeg",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0 and _is_moderation_blocked(res.stderr):
        safe_prompt = _soften_prompt(prompt)
        retry_cmd = [
            sys.executable, str(EDIT_SCRIPT),
            "--image", str(image_in),
            "--prompt", safe_prompt,
            "--output", str(out),
            "--size", size,
            "--quality", "low",
            "--format", "jpeg",
        ]
        res = subprocess.run(retry_cmd, capture_output=True, text=True, encoding="utf-8")
    if res.returncode != 0:
        raise RuntimeError(f"edit.py failed: {res.stderr.strip()[:600]}")
    return Path(res.stdout.strip().splitlines()[-1])


def _resolve_size_for_box(scene_dir: Path, box_id: str, default: str) -> str:
    """Snap the box's aspect to a valid mid-resolution gpt-image-2 size."""
    # Prefer the aspect of the actual imageB file on disk (most accurate).
    img_b = scene_dir / "exp3" / "imageB" / f"box-{box_id}.jpg"
    try:
        from PIL import Image as _Image  # local import to keep top-level imports tidy
        if img_b.exists():
            with _Image.open(img_b) as im:
                w, h = im.size
                tw, th = snap_aspect(w, h, target_pixels=QUEST_TARGET_PIXELS)
                return f"{tw}x{th}"
    except Exception:
        pass
    # Fallback: the saved meta (boxes[].w/h) via the geom file.
    geom_path = scene_dir / "crops" / f"box-{box_id}-geom.json"
    if geom_path.exists():
        try:
            geom = json.loads(geom_path.read_text(encoding="utf-8"))
            crop = geom.get("crop_in_master", {})
            w, h = float(crop.get("w") or 0), float(crop.get("h") or 0)
            if w > 0 and h > 0:
                tw, th = snap_aspect(w, h, target_pixels=QUEST_TARGET_PIXELS)
                return f"{tw}x{th}"
            parsed = parse_aspect_label(geom.get("aspect", "")) or (2, 3)
            tw, th = snap_aspect(*parsed, target_pixels=QUEST_TARGET_PIXELS)
            return f"{tw}x{th}"
        except Exception:
            pass
    return default


def generate_quest(scene_id: str, quest_id: str) -> dict:
    scene_dir = SCENES / scene_id
    meta_path = scene_dir / "meta.json"
    if not meta_path.exists():
        raise RuntimeError(f"scene '{scene_id}' not found")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    quest = next((q for q in meta.get("quests", []) if str(q.get("id")) == str(quest_id)), None)
    if not quest:
        raise RuntimeError(f"quest '{quest_id}' not found in scene '{scene_id}'")

    box_id = str(quest.get("box_id") or "")
    if not box_id:
        raise RuntimeError("quest has no box_id")

    img_b = scene_dir / "exp3/imageB" / f"box-{box_id}.jpg"
    img_c = scene_dir / "exp3/imageC" / f"box-{box_id}.jpg"
    if not img_b.exists():
        raise RuntimeError(f"imageB missing for box {box_id}: {img_b}")
    if not img_c.exists():
        raise RuntimeError(f"imageC missing for box {box_id}: {img_c}")

    out_dir = scene_dir / "quests" / quest_id
    out_dir.mkdir(parents=True, exist_ok=True)

    prompt1 = (quest.get("image1_prompt") or "").strip()
    prompt2 = (quest.get("image2_prompt") or "").strip()
    if not prompt1 or not prompt2:
        raise RuntimeError("quest must define both image1_prompt and image2_prompt")

    size_b = _resolve_size_for_box(scene_dir, box_id, "1152x1728")
    print(f"[quest {quest_id}] image1 from {img_b.name} -> size {size_b}", flush=True)
    out1 = _gpt_edit(img_b, prompt1, out_dir / "image1.jpg", size=size_b)
    print(f"[quest {quest_id}] image1 done: {out1.name}", flush=True)

    size_2 = "{}x{}".format(*snap_aspect(2, 3, target_pixels=QUEST_TARGET_PIXELS))
    print(f"[quest {quest_id}] image2 from {img_c.name} -> size {size_2}", flush=True)
    out2 = _gpt_edit(img_c, prompt2, out_dir / "image2.jpg", size=size_2)
    print(f"[quest {quest_id}] image2 done: {out2.name}", flush=True)

    return {"image1": str(out1), "image2": str(out2)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scene", required=True)
    ap.add_argument("--quest", required=True)
    args = ap.parse_args()
    try:
        result = generate_quest(args.scene, args.quest)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as e:
        print(f"!! {e}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
