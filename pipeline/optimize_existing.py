"""One-shot: convert master.png and exp3/imageB,imageC PNGs to JPEG (q=85).

Removes the originals after a successful save. Skips any file that has no
matching PNG. Idempotent: safe to re-run.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"

TARGETS: list[Path] = []
TARGETS.append(PUBLIC / "master.png")
for sub in ("imageB", "imageC"):
    d = PUBLIC / "exp3" / sub
    if d.exists():
        TARGETS.extend(sorted(d.glob("*.png")))


def main() -> int:
    total_before = 0
    total_after = 0
    converted = 0
    for src in TARGETS:
        if not src.exists():
            continue
        dst = src.with_suffix(".jpg")
        before = src.stat().st_size
        img = Image.open(src).convert("RGB")
        img.save(dst, "JPEG", quality=85, optimize=True)
        after = dst.stat().st_size
        src.unlink()
        total_before += before
        total_after += after
        converted += 1
        print(f"{src.name} {before//1024} KB -> {dst.name} {after//1024} KB", flush=True)

    saved = total_before - total_after
    pct = (saved / total_before * 100) if total_before else 0
    print(f"\n{converted} files converted")
    print(f"  before: {total_before/1_048_576:.1f} MB")
    print(f"  after:  {total_after/1_048_576:.1f} MB")
    print(f"  saved:  {saved/1_048_576:.1f} MB ({pct:.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
