"""Regenerate selected per-box assets for a single box.

Inputs (env or CLI):
  ACCROCHE_BOX  : JSON dict for one box {id, x, y, w, h, aspect, subject}
  ACCROCHE_OPTS : JSON dict {imageB: bool, imageC: bool, dessin: bool}

Operates on public/ root (the active scene). Run AFTER the master is in place.
The output files for this box id are overwritten:
  public/crops/box-{id}-input.png    (always re-extracted to ensure freshness)
  public/crops/box-{id}-raw.png      (only if dessin)
  public/crops/box-{id}-line.png     (only if dessin)
  public/lineart-svg/box-{id}-skel.svg (only if dessin)
  public/exp3/imageB/box-{id}.jpg    (only if imageB)
  public/exp3/imageC/box-{id}.jpg    (only if imageC)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PIPELINE = ROOT / "pipeline"
PUBLIC = ROOT / "public"

sys.path.insert(0, str(PIPELINE))


def _wipe_assets_for(box_id: str, opts: dict) -> None:
    """Remove the existing artifacts we are about to replace."""
    if opts.get("imageB"):
        for f in (PUBLIC / "exp3" / "imageB").glob(f"box-{box_id}*.jpg"):
            f.unlink(missing_ok=True)
        for f in (PUBLIC / "exp3" / "imageB").glob(f"box-{box_id}*.png"):
            f.unlink(missing_ok=True)
    if opts.get("imageC"):
        for f in (PUBLIC / "exp3" / "imageC").glob(f"box-{box_id}*.jpg"):
            f.unlink(missing_ok=True)
        for f in (PUBLIC / "exp3" / "imageC").glob(f"box-{box_id}*.png"):
            f.unlink(missing_ok=True)
    if opts.get("dessin"):
        for f in (PUBLIC / "crops").glob(f"box-{box_id}-raw*.png"):
            f.unlink(missing_ok=True)
        for f in (PUBLIC / "crops").glob(f"box-{box_id}-line.png"):
            f.unlink(missing_ok=True)
        for f in (PUBLIC / "lineart-svg").glob(f"box-{box_id}-skel.svg"):
            f.unlink(missing_ok=True)


def regen_one(box: dict, opts: dict) -> dict:
    import lineart  # noqa: WPS433  (lazy import after sys.path tweak)
    import exp3
    import skeletonize_lineart

    box_id = str(box["id"])
    print(f"[regen {box_id}] options={opts}", flush=True)
    _wipe_assets_for(box_id, opts)

    # Always ensure the input crop is fresh (it grounds B and the dessin).
    print(f"[regen {box_id}] extract input crop", flush=True)
    lineart.extract_box_input(box)

    # Step 1+2 in parallel: image B and the GPT line-art trace (independent reads).
    tasks = []
    if opts.get("imageB"):
        tasks.append(("imageB", exp3.make_imageB, (box,)))
    if opts.get("dessin"):
        tasks.append(("dessin-trace", lineart.run_gpt_only, (box,)))

    results: dict[str, str] = {}
    if tasks:
        with ThreadPoolExecutor(max_workers=len(tasks)) as ex:
            futs = {ex.submit(fn, *args): name for name, fn, args in tasks}
            for f in as_completed(futs):
                name = futs[f]
                try:
                    f.result()
                    results[name] = "ok"
                    print(f"[regen {box_id}] {name} done", flush=True)
                except Exception as e:
                    results[name] = f"error: {e}"
                    print(f"[regen {box_id}] {name} FAILED: {e}", flush=True)

    # Step 3: skeletonize (depends on dessin-trace), and image C (depends on imageB).
    tasks2 = []
    if opts.get("dessin") and results.get("dessin-trace") == "ok":
        tasks2.append(("dessin-skel", skeletonize_lineart.skeletonize_one, (box_id,)))
    if opts.get("imageC"):
        # imageC needs imageB to exist. If we just made it, fine; otherwise the
        # existing one stays in place.
        b_path = PUBLIC / "exp3/imageB" / f"box-{box_id}.jpg"
        if not b_path.exists():
            b_path = PUBLIC / "exp3/imageB" / f"box-{box_id}.png"
        if not b_path.exists():
            results["imageC"] = "error: image B missing — coche aussi 'image zoom 1'"
        else:
            tasks2.append(("imageC", exp3.make_imageC, (box,)))

    if tasks2:
        with ThreadPoolExecutor(max_workers=len(tasks2)) as ex:
            futs = {ex.submit(fn, *args): name for name, fn, args in tasks2}
            for f in as_completed(futs):
                name = futs[f]
                try:
                    f.result()
                    results[name] = "ok"
                    print(f"[regen {box_id}] {name} done", flush=True)
                except Exception as e:
                    results[name] = f"error: {e}"
                    print(f"[regen {box_id}] {name} FAILED: {e}", flush=True)

    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--box", help="JSON box dict (overrides env)")
    ap.add_argument("--opts", help='JSON {"imageB":bool,"imageC":bool,"dessin":bool}')
    args = ap.parse_args()

    box_json = args.box or os.environ.get("ACCROCHE_BOX") or ""
    opts_json = args.opts or os.environ.get("ACCROCHE_OPTS") or "{}"
    if not box_json:
        print("missing box JSON", flush=True)
        return 2
    box = json.loads(box_json)
    opts = json.loads(opts_json)

    try:
        res = regen_one(box, opts)
    except Exception as e:
        print(f"!! regen failed: {e}", flush=True)
        return 1
    print(json.dumps(res, ensure_ascii=False), flush=True)
    return 0 if all(v == "ok" for v in res.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
