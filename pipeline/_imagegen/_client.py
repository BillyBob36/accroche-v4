"""Shared HTTP client + config + counter for the image-gen-azure skill."""
from __future__ import annotations

import json
import os
import sys
import time
import uuid
from datetime import date
from pathlib import Path
from urllib import error, request

# En production (Coolify), les vars sont injectées via l'environnement, pas
# besoin de .env. En local, on cherche un .env à la racine du projet.
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # accroche/
STATE_DIR = PROJECT_ROOT / ".image-state"
COUNTER_FILE = STATE_DIR / "today.json"
DAILY_WARN_THRESHOLD = 10


def _load_dotenv() -> None:
    """Charge un .env optionnel à la racine du projet (mode dev local)."""
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and not os.environ.get(k):  # ne pas écraser les vars déjà définies
            os.environ[k] = v


def get_config() -> dict:
    _load_dotenv()
    cfg = {
        "endpoint": os.environ.get("AZURE_OPENAI_ENDPOINT", "").rstrip("/"),
        "deployment": os.environ.get("AZURE_OPENAI_DEPLOYMENT", ""),
        "api_version": os.environ.get("AZURE_OPENAI_API_VERSION", "2024-02-01"),
        "api_key": os.environ.get("AZURE_OPENAI_API_KEY", ""),
    }
    missing = [k for k, v in cfg.items() if not v]
    if missing:
        die(f"Missing config: {missing}. Edit {SKILL_ROOT / '.env'}")
    return cfg


def build_url(cfg: dict, action: str) -> str:
    return (
        f"{cfg['endpoint']}/openai/deployments/{cfg['deployment']}"
        f"/images/{action}?api-version={cfg['api_version']}"
    )


def auth_headers(cfg: dict) -> dict:
    # Azure OpenAI canonical auth. Bearer also works on this endpoint, but
    # sending both simultaneously causes 401 — pick one.
    return {"api-key": cfg["api_key"]}


def post_json(url: str, payload: dict, headers: dict, max_retries: int = 6) -> dict:
    body = json.dumps(payload).encode("utf-8")
    headers = {**headers, "Content-Type": "application/json"}
    return _request_with_retry(url, body, headers, max_retries)


def post_multipart(
    url: str, fields: list[tuple[str, str]], files: list[tuple[str, Path]],
    headers: dict, max_retries: int = 6,
) -> dict:
    """fields: [(name, value), ...]. files: [(name, path), ...]. name can repeat (e.g. multiple 'image' parts)."""
    boundary = f"----formboundary{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )
    for name, path in files:
        path = Path(path)
        ext = path.suffix.lower().lstrip(".") or "png"
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "webp": "image/webp"}.get(ext, "application/octet-stream")
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{path.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n".encode("utf-8")
        )
        parts.append(path.read_bytes())
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    body = b"".join(parts)
    headers = {**headers, "Content-Type": f"multipart/form-data; boundary={boundary}"}
    return _request_with_retry(url, body, headers, max_retries)


def _request_with_retry(url: str, body: bytes, headers: dict, max_retries: int) -> dict:
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = request.Request(url, data=body, headers=headers, method="POST")
            with request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace")
            if e.code == 429:
                # Respect Retry-After header if present, otherwise apply
                # exponential backoff capped at 90s (avoid pathological waits).
                # Many Azure deployments use a 60s sliding window for
                # rate-limits, so a single 60s wait is usually enough to clear.
                hdr = e.headers.get("Retry-After")
                if hdr and hdr.isdigit():
                    wait = int(hdr)
                else:
                    wait = min(6 * (2 ** attempt), 90)
                print(f"[rate-limit] 429, sleeping {wait}s (attempt {attempt+1}/{max_retries})",
                      file=sys.stderr)
                time.sleep(wait)
                last_err = e
                continue
            if 500 <= e.code < 600 and attempt < max_retries - 1:
                wait = min(2 ** attempt, 30)
                print(f"[server-error] {e.code}, retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
                last_err = e
                continue
            die(f"HTTP {e.code}: {err_body}")
        except error.URLError as e:
            last_err = e
            if attempt < max_retries - 1:
                wait = min(2 ** attempt, 30)
                print(f"[network] {e}, retrying in {wait}s", file=sys.stderr)
                time.sleep(wait)
                continue
            die(f"Network error: {e}")
    die(f"Exhausted retries: {last_err}")


def die(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def increment_counter() -> int:
    """Increment daily counter, reset on new day, return new count."""
    STATE_DIR.mkdir(exist_ok=True)
    today = date.today().isoformat()
    state = {"date": today, "count": 0}
    if COUNTER_FILE.exists():
        try:
            state = json.loads(COUNTER_FILE.read_text(encoding="utf-8"))
            if state.get("date") != today:
                state = {"date": today, "count": 0}
        except (json.JSONDecodeError, OSError):
            pass
    state["count"] = int(state.get("count", 0)) + 1
    COUNTER_FILE.write_text(json.dumps(state), encoding="utf-8")
    return state["count"]


def report_count(n_added: int) -> None:
    final = 0
    for _ in range(n_added):
        final = increment_counter()
    flag = " [OVER THRESHOLD — confirm with user before more]" if final > DAILY_WARN_THRESHOLD else ""
    print(f"[counter] {final}/{DAILY_WARN_THRESHOLD} images today{flag}", file=sys.stderr)


def validate_size(s: str) -> str:
    """gpt-image-2 size constraints: WxH, both edges multiple of 16,
    long edge <=3840, ratio <=3:1, total pixels 655360-8294400. Also accepts 'auto'."""
    import argparse
    if s == "auto":
        return s
    try:
        w, h = s.lower().split("x")
        w, h = int(w), int(h)
    except (ValueError, AttributeError):
        raise argparse.ArgumentTypeError(f"Bad size '{s}'. Use WIDTHxHEIGHT (e.g. 1024x1024) or 'auto'.")
    if w % 16 or h % 16:
        raise argparse.ArgumentTypeError(f"Both edges must be multiples of 16 (got {w}x{h}).")
    if max(w, h) > 3840:
        raise argparse.ArgumentTypeError(f"Long edge must be <=3840 (got {max(w, h)}).")
    ratio = max(w, h) / min(w, h)
    if ratio > 3.0:
        raise argparse.ArgumentTypeError(f"Aspect ratio must be <=3:1 (got {ratio:.2f}:1).")
    pixels = w * h
    if pixels < 655_360 or pixels > 8_294_400:
        raise argparse.ArgumentTypeError(
            f"Total pixels must be 655360-8294400 (got {pixels}). "
            f"Try sizes between ~800x800 and ~3840x2160."
        )
    return s


def slugify(text: str, max_len: int = 50) -> str:
    out = []
    for c in text.lower():
        if c.isalnum():
            out.append(c)
        elif c in " -_":
            out.append("-")
    s = "".join(out)
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")[:max_len] or "image"


def resolve_output_path(output_arg: str | None, prompt: str, ext: str, idx: int = 0, total: int = 1) -> Path:
    if output_arg:
        p = Path(output_arg)
    else:
        default_dir = Path.cwd() / "public" / "images" / "generated"
        p = default_dir / f"{slugify(prompt)}.{ext}"
    if total > 1:
        p = p.with_name(f"{p.stem}-{idx+1}{p.suffix}")
    p.parent.mkdir(parents=True, exist_ok=True)
    if p.exists():
        # avoid clobbering — append timestamp
        ts = int(time.time())
        p = p.with_name(f"{p.stem}-{ts}{p.suffix}")
    return p


def save_b64(b64: str, path: Path) -> None:
    import base64
    path.write_bytes(base64.b64decode(b64))
