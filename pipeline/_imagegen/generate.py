"""Text-to-image generation via Azure OpenAI gpt-image-2.

Usage:
  python generate.py --prompt "..." [--output PATH] [--size 1024x1024] [--quality medium]
                     [--n 1] [--format png] [--compression 80] [--transparent]
                     [--background transparent|opaque|auto] [--moderation low|auto]
"""
from __future__ import annotations

import argparse
import sys

from _client import (
    auth_headers, build_url, get_config, post_json,
    report_count, resolve_output_path, save_b64, validate_size,
)
from _bg_remove import remove_uniform_bg

VALID_QUALITIES = ["low", "medium", "high", "auto"]
VALID_FORMATS = ["png", "jpeg", "webp"]
VALID_BACKGROUNDS = ["transparent", "opaque", "auto"]
VALID_MODERATIONS = ["low", "auto"]


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate images with Azure OpenAI gpt-image-2")
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--output", help="Output file path. Default: ./public/images/generated/<slug>.<ext>")
    ap.add_argument("--size", default="1024x1024", type=validate_size,
                    help="WIDTHxHEIGHT or 'auto'. Edges multiple of 16, long edge <=3840, "
                         "ratio <=3:1, total pixels 655360-8294400.")
    ap.add_argument("--quality", default="medium", choices=VALID_QUALITIES)
    ap.add_argument("--n", type=int, default=1)
    ap.add_argument("--format", dest="output_format", default="png", choices=VALID_FORMATS)
    ap.add_argument("--compression", type=int, default=None,
                    help="0-100, only for jpeg/webp")
    ap.add_argument("--transparent", action="store_true",
                    help="Force PNG + transparent background")
    ap.add_argument("--background", choices=VALID_BACKGROUNDS, default=None)
    ap.add_argument("--moderation", choices=VALID_MODERATIONS, default=None)
    args = ap.parse_args()

    # Note: gpt-image-2 on Azure currently rejects background=transparent.
    # `--transparent` is implemented as a two-step pipeline:
    #   1) augment prompt for clean cutout
    #   2) post-process with Pillow to make the uniform background transparent
    do_bg_remove = False
    if args.transparent:
        args.output_format = "png"
        do_bg_remove = True
        cutout_hint = (
            ", isolated subject centered on a plain solid white background, "
            "no shadow, sharp clean edges, studio cutout style, no text"
        )
        if cutout_hint not in args.prompt:
            args.prompt = args.prompt + cutout_hint

    cfg = get_config()
    url = build_url(cfg, "generations")

    payload: dict = {
        "prompt": args.prompt,
        "size": args.size,
        "quality": args.quality,
        "n": args.n,
        "output_format": args.output_format,
    }
    if args.compression is not None and args.output_format in ("jpeg", "webp"):
        payload["output_compression"] = args.compression
    if args.background is not None:
        payload["background"] = args.background
    if args.moderation is not None:
        payload["moderation"] = args.moderation

    print(f"[generate] {args.size} {args.quality} n={args.n} fmt={args.output_format}"
          f"{' transparent' if args.background == 'transparent' else ''}", file=sys.stderr)

    resp = post_json(url, payload, auth_headers(cfg))
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
        print(str(p))  # stdout = saved paths, one per line
    report_count(len(saved))
    return 0


if __name__ == "__main__":
    sys.exit(main())
