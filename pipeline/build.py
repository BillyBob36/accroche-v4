"""Generate the master 2560x1440 boutique image via gpt-image-2.

Reads the prompt from CLI arg, env var ACCROCHE_PROMPT, or falls back to
the default boutique prompt. Always overwrites public/master.png.

Quality is medium by default (~30-90s). High quality often hits the 180s
client timeout for 2560x1440.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

SKILL_SCRIPTS = Path(__file__).resolve().parent / "_imagegen"
sys.path.insert(0, str(SKILL_SCRIPTS))

from _client import auth_headers, build_url, get_config, post_json, save_b64  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
MASTER_PATH = PUBLIC / "master.jpg"  # JPEG ~3-5x smaller than PNG, same visual
PROMPT_PATH = PUBLIC / ".master_prompt.txt"

DEFAULT_PROMPT = (
    "Hero photograph for a luxury fashion editorial. "
    "Inside a high-end designer handbag boutique: warm marble floors, "
    "soft golden display lighting, glass shelves with handbags arranged sparsely. "
    "Five well-dressed customers visible: a woman in a beige trench coat examining a bag "
    "on the left, a stylish couple in dark coats near the center looking at a display, "
    "a young woman in a red dress holding a handbag near the back-right, and a man in a "
    "tailored navy suit standing near the entrance on the right. "
    "Wide landscape composition, eye-level, shallow depth of field, golden-hour ambient light "
    "through tall windows, photorealistic, magazine-quality. "
    "All customers fully visible, head to mid-thigh at minimum, well-spaced apart. "
    "No watermark, no text, no logos, no trademarks."
)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", help="full text prompt for the master scene")
    ap.add_argument("--quality", default="medium", choices=["low", "medium", "high", "auto"])
    args = ap.parse_args()

    prompt = args.prompt or os.environ.get("ACCROCHE_PROMPT") or DEFAULT_PROMPT

    PUBLIC.mkdir(parents=True, exist_ok=True)
    PROMPT_PATH.write_text(prompt, encoding="utf-8")

    cfg = get_config()
    url = build_url(cfg, "generations")
    payload = {
        "prompt": prompt,
        "size": "2560x1440",
        "quality": args.quality,
        "n": 1,
        "output_format": "jpeg",
        "output_compression": 85,
    }
    print(f"[master] generating 2560x1440 quality={args.quality} (~30-150s)...", file=sys.stderr, flush=True)
    t0 = time.time()
    resp = post_json(url, payload, auth_headers(cfg))
    save_b64(resp["data"][0]["b64_json"], MASTER_PATH)
    print(f"[master] saved in {time.time() - t0:.1f}s -> {MASTER_PATH}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
