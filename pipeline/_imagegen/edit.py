"""Image editing / inpainting / multi-image composition via Azure OpenAI gpt-image-2.

Usage:
  python edit.py --image IN.png [--image IN2.png ...] [--mask MASK.png] --prompt "..."
                 [--output PATH] [--size 1024x1024] [--quality medium] [--n 1]
                 [--format png] [--transparent] [--background transparent|opaque|auto]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from _client import (
    auth_headers, build_url, die, get_config, post_multipart,
    report_count, resolve_output_path, save_b64, validate_size,
)
from _bg_remove import remove_uniform_bg

VALID_QUALITIES = ["low", "medium", "high", "auto"]
VALID_FORMATS = ["png", "jpeg", "webp"]
VALID_BACKGROUNDS = ["transparent", "opaque", "auto"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Edit images with Azure OpenAI gpt-image-2")
    ap.add_argument("--image", action="append", required=True,
                    help="Input image (repeat for multi-image composition)")
    ap.add_argument("--mask", help="Optional mask PNG (transparent areas = edit zone)")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--output")
    ap.add_argument("--size", default="1024x1024", type=validate_size,
                    help="WIDTHxHEIGHT or 'auto'. Edges multiple of 16, long edge <=3840, "
                         "ratio <=3:1, total pixels 655360-8294400.")
    ap.add_argument("--quality", default="medium", choices=VALID_QUALITIES)
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--format", dest="output_format", default="png", choices=VALID_FORMATS)
    ap.add_argument("--transparent", action="store_true")
    ap.add_argument("--background", choices=VALID_BACKGROUNDS, default=None)
    args = ap.parse_args()

    # gpt-image-2 on Azure rejects background=transparent. We post-process with Pillow.
    do_bg_remove = False
    if args.transparent:
        args.output_format = "png"
        do_bg_remove = True
        args.background = None  # don't send rejected param

    for img in args.image:
        if not Path(img).exists():
            die(f"Image not found: {img}")
    if args.mask and not Path(args.mask).exists():
        die(f"Mask not found: {args.mask}")

    cfg = get_config()
    url = build_url(cfg, "edits")

    fields: list[tuple[str, str]] = [
        ("prompt", args.prompt),
        ("size", args.size),
        ("quality", args.quality),
        ("n", str(args.n)),
        ("output_format", args.output_format),
    ]
    if args.background is not None:
        fields.append(("background", args.background))

    files: list[tuple[str, Path]] = []
    # For multiple images, the multipart spec is to repeat the "image" field.
    # gpt-image-1/2 API also accepts "image[]" — we send "image" which is the canonical form.
    for img in args.image:
        files.append(("image", Path(img)))
    if args.mask:
        files.append(("mask", Path(args.mask)))

    print(f"[edit] {len(args.image)} input(s){' +mask' if args.mask else ''} "
          f"{args.size} {args.quality} n={args.n}", file=sys.stderr)

    resp = post_multipart(url, fields, files, auth_headers(cfg))
    data = resp.get("data") or []
    if not data:
        print(f"ERROR: empty response: {resp}", file=sys.stderr)
        return 1

    saved = []
    for i, item in enumerate(data):
        b64 = item.get("b64_json")
        if not b64:
            print(f"ERROR: no b64_json in item {i}: {item}", file=sys.stderr)
            return 1
        out = resolve_output_path(args.output, args.prompt, args.output_format, i, len(data))
        save_b64(b64, out)
        if do_bg_remove:
            print(f"[transparent] removing uniform background from {out.name}", file=sys.stderr)
            remove_uniform_bg(out)
        saved.append(out)

    for p in saved:
        print(str(p))
    report_count(len(saved))
    return 0


if __name__ == "__main__":
    sys.exit(main())
