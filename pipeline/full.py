"""End-to-end box-driven pipeline.

Phases (status written to public/.gen_status.json after each):
  1. master  (only if no master.png exists yet, or env requests regen)
  2. line-arts + image B per box  (in parallel)
  3. skeletonize + image C per box  (in parallel)

Boxes are read from env ACCROCHE_BOXES (JSON string) or public/.boxes.json.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
PIPELINE = ROOT / "pipeline"
STATUS = PUBLIC / ".gen_status.json"
BOXES_FILE = PUBLIC / ".boxes.json"

PHASES = [
    "Génération du master 2560x1440 (si nécessaire)",
    "Dessins ligne + portraits sujet/bokeh par cadre (en parallèle)",
    "Squelettisation + plans américains par cadre (en parallèle)",
]
TOTAL_PHASES = len(PHASES)

sys.path.insert(0, str(PIPELINE))


def write_status(**kw):
    STATUS.parent.mkdir(parents=True, exist_ok=True)
    STATUS.write_text(json.dumps(kw, indent=2), encoding="utf-8")


def update_phase(idx, prompt, **extra):
    write_status(running=True, step=PHASES[idx - 1], step_index=idx, total_steps=TOTAL_PHASES,
                 error=None, started_at=time.time(), prompt=prompt, **extra)
    print(f"\n>>> [{idx}/{TOTAL_PHASES}] {PHASES[idx - 1]}", flush=True)


def wipe_per_box_outputs():
    """Remove generated artefacts from prior runs so stale box ids don't linger."""
    for d in [
        PUBLIC / "crops",
        PUBLIC / "lineart-svg",
        PUBLIC / "exp3" / "imageB",
        PUBLIC / "exp3" / "imageC",
    ]:
        if d.exists():
            shutil.rmtree(d)
        # Recreate the directory so subsequent writes don't have to mkdir each time
        d.mkdir(parents=True, exist_ok=True)


def wipe_orphan_box_files(boxes: list) -> None:
    """Remove any per-box files whose id is NOT in the current boxes list.

    Defensive cleanup on top of wipe_per_box_outputs (which nukes everything).
    Useful when a regen-box flow ran for a box that was later deleted from the
    scene — those orphan files can confuse subsequent runs.
    """
    import re as _re
    valid_ids = {str(b.get("id")) for b in boxes}
    pattern = _re.compile(r"^box-([^-/]+)[-.]")

    for d, exts in [
        (PUBLIC / "crops",          ("png", "json")),
        (PUBLIC / "lineart-svg",    ("svg",)),
        (PUBLIC / "exp3" / "imageB", ("jpg", "jpeg", "png", "webp")),
        (PUBLIC / "exp3" / "imageC", ("jpg", "jpeg", "png", "webp")),
    ]:
        if not d.exists():
            continue
        for f in d.iterdir():
            if not f.is_file():
                continue
            m = pattern.match(f.name)
            if not m:
                continue
            box_id = m.group(1)
            if box_id not in valid_ids:
                try:
                    f.unlink()
                    print(f"  - wiped orphan {f.relative_to(PUBLIC)}", flush=True)
                except OSError:
                    pass


def run_subprocess(cmd, prompt):
    env = os.environ.copy()
    env["ACCROCHE_PROMPT"] = prompt
    env["PYTHONIOENCODING"] = "utf-8"
    res = subprocess.run(cmd, env=env, cwd=str(ROOT))
    if res.returncode != 0:
        raise RuntimeError(f"{Path(cmd[1]).name} failed (exit {res.returncode})")


def run_parallel(funcs_and_args, max_workers):
    errors = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [ex.submit(fn, *args) for fn, *args in funcs_and_args]
        for f in as_completed(futs):
            try:
                f.result()
            except BaseException as e:
                errors.append(e)
                print(f"  ! parallel task failed: {e}", flush=True)
    if errors:
        raise errors[0]


def load_boxes():
    raw = os.environ.get("ACCROCHE_BOXES")
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            pass
    if BOXES_FILE.exists():
        return json.loads(BOXES_FILE.read_text(encoding="utf-8"))
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", help="text prompt for the master scene (only used if master.png missing)")
    args = ap.parse_args()
    prompt = args.prompt or os.environ.get("ACCROCHE_PROMPT") or ""

    boxes = load_boxes()
    if not boxes:
        write_status(running=False, error="no boxes provided", prompt=prompt)
        print("!!! no boxes — aborting", flush=True)
        return 1

    # Persist boxes that came in via env so the rest of the pipeline can read them.
    BOXES_FILE.write_text(json.dumps(boxes, indent=2), encoding="utf-8")

    write_status(running=True, step="Préparation", step_index=0, total_steps=TOTAL_PHASES,
                 error=None, started_at=time.time(), prompt=prompt)

    try:
        wipe_per_box_outputs()
        wipe_orphan_box_files(boxes)

        # Phase 1: master (skip if already present and no prompt forces a regen)
        master_path = PUBLIC / "master.jpg"
        if not master_path.exists() and not (PUBLIC / "master.png").exists():
            update_phase(1, prompt)
            if not prompt:
                from build import DEFAULT_PROMPT  # type: ignore
                prompt = DEFAULT_PROMPT
            run_subprocess([sys.executable, str(PIPELINE / "build.py")], prompt)
        else:
            update_phase(1, prompt, skipped=True)
            print("  master.png already present — skipping master generation", flush=True)

        # Phase 2: extract crops first (fast, sequential — avoids race between
        # lineart and exp3.make_imageB which both read the input crop file),
        # then run line-arts + image B in parallel.
        import lineart
        import exp3
        update_phase(2, prompt)
        for box in boxes:
            lineart.extract_box_input(box)
        tasks = []
        for box in boxes:
            tasks.append((lineart.run_gpt_only, box))
            tasks.append((exp3.make_imageB, box))
        run_parallel(tasks, max_workers=10)

        # Phase 3: skeletonize + image C per box, all in parallel
        import skeletonize_lineart
        update_phase(3, prompt)
        tasks = []
        for box in boxes:
            tasks.append((skeletonize_lineart.skeletonize_one, str(box["id"])))
            tasks.append((exp3.make_imageC, box))
        run_parallel(tasks, max_workers=10)

    except Exception as e:
        write_status(running=False, step_index=None, total_steps=TOTAL_PHASES,
                     step=None, error=str(e), prompt=prompt)
        print(f"\n!!! pipeline failed: {e}", flush=True)
        return 1

    write_status(running=False, step_index=TOTAL_PHASES, total_steps=TOTAL_PHASES,
                 step="Terminé", error=None, prompt=prompt, finished_at=time.time(),
                 box_ids=[str(b["id"]) for b in boxes])
    print("\n=== pipeline finished ===", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
