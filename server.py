"""Static file server for public/ + API endpoints for the box-driven pipeline.

Endpoints:
  GET  /api/status              -> current pipeline status (JSON)
  POST /api/master/upload       -> multipart form, field "image"; resize/crop to 2560x1440 + save master.png
  POST /api/master/generate     -> body { prompt }, kick off build.py only (master gen)
  POST /api/boxes               -> body { boxes: [...] }, save user-drawn boxes
  GET  /api/boxes               -> return saved boxes (or [])
  POST /api/generate            -> body { boxes: [...] }, kick off the box-driven pipeline

  -- Scenes (saved modules) --
  POST /api/scenes              -> body { name, category? }, snapshot current public/* into a scene
  GET  /api/scenes              -> list all saved scenes (id, name, box_count, ...)
  GET  /api/scenes/<id>         -> full meta.json
  POST /api/scenes/<id>/load    -> copy scene's assets back into public/ (master, boxes, lineart, exp3)
  DELETE /api/scenes/<id>       -> remove a scene
  POST /api/scenes/<id>/meta    -> body { name?, level1_questions?, quests? } merge-update meta.json
  POST /api/scenes/<id>/quest/<qid>/generate -> generate quest image1+image2 for a quest

All other paths serve files under public/.
"""
from __future__ import annotations

import datetime as _dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import unicodedata
from email.parser import BytesParser
from email.policy import default as default_policy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
STATUS_FILE = PUBLIC / ".gen_status.json"
BOXES_FILE = PUBLIC / ".boxes.json"
MASTER_PATH = PUBLIC / "master.jpg"
SCENES_DIR = PUBLIC / "scenes"
PIPELINE_FULL = ROOT / "pipeline" / "full.py"
PIPELINE_BUILD = ROOT / "pipeline" / "build.py"
PIPELINE_QUEST = ROOT / "pipeline" / "quest_gen.py"
PIPELINE_REGEN_BOX = ROOT / "pipeline" / "regen_box.py"
PIPELINE_CHAR_EDIT = ROOT / "pipeline" / "character_edit.py"

MASTER_W, MASTER_H = 2560, 1440

_lock = threading.Lock()
_running = False

# ---------- Cloudflare quick tunnel state ----------
# We launch `cloudflared tunnel --url http://localhost:<PORT>` and parse its
# stderr for the `https://<random>.trycloudflare.com` URL it announces. The
# tunnel runs as a child subprocess; killing the server kills the tunnel.
_tunnel_lock = threading.Lock()
_tunnel: dict[str, object] = {
    "process": None,        # subprocess.Popen | None
    "url": None,            # str | None — public URL once known
    "started_at": None,     # ISO string
    "error": None,          # str | None
}

CLOUDFLARED = r"C:\Program Files\cloudflared\cloudflared.exe"

_RE_TRYCF = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


# ---------- helpers ----------

def _slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "scene"


def _now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def _read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default
    except Exception:
        return default


def _write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _list_scene_ids() -> list[str]:
    if not SCENES_DIR.exists():
        return []
    return sorted(p.name for p in SCENES_DIR.iterdir() if (p / "meta.json").exists())


def _scene_meta(scene_id: str) -> dict | None:
    meta = SCENES_DIR / scene_id / "meta.json"
    if not meta.exists():
        return None
    return _read_json(meta, None)


def _snapshot_current_scene(name: str, category: str = "") -> dict:
    """Copy the current state of public/ (master, boxes, lineart-svg, exp3) into scenes/<slug>/."""
    slug = _slugify(name)
    base = SCENES_DIR / slug
    if base.exists():
        # If a scene with this slug already exists, append a numeric suffix
        i = 2
        while (SCENES_DIR / f"{slug}-{i}").exists():
            i += 1
        slug = f"{slug}-{i}"
        base = SCENES_DIR / slug
    base.mkdir(parents=True, exist_ok=True)

    # master.jpg (or master.png as fallback)
    master_src = MASTER_PATH if MASTER_PATH.exists() else (PUBLIC / "master.png")
    if master_src.exists():
        shutil.copy2(master_src, base / master_src.name)

    # boxes
    boxes = _read_json(BOXES_FILE, [])

    # lineart-svg/, exp3/imageB/, exp3/imageC/, crops/
    for sub in ("lineart-svg", "exp3/imageB", "exp3/imageC", "crops"):
        src = PUBLIC / sub
        if src.exists():
            dst = base / sub
            dst.mkdir(parents=True, exist_ok=True)
            for f in src.iterdir():
                if f.is_file():
                    shutil.copy2(f, dst / f.name)

    meta = {
        "id": slug,
        "name": name,
        "category": category,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
        "box_count": len(boxes),
        "boxes": boxes,
        "level1_questions": [],
        "quests": [],
        "master_filename": master_src.name if master_src.exists() else None,
    }
    _write_json(base / "meta.json", meta)
    _write_json(base / "boxes.json", boxes)
    return meta


def _restore_scene(scene_id: str) -> bool:
    """Restore a saved scene's assets back into public/ root so the editor/pipeline operates on it."""
    base = SCENES_DIR / scene_id
    meta = _scene_meta(scene_id)
    if not meta:
        return False

    # master
    for ext in ("jpg", "png"):
        for stale in PUBLIC.glob(f"master.{ext}"):
            stale.unlink()
    master_name = meta.get("master_filename") or "master.jpg"
    src_master = base / master_name
    if src_master.exists():
        shutil.copy2(src_master, PUBLIC / src_master.name)

    # boxes
    _write_json(BOXES_FILE, meta.get("boxes", []))

    # asset dirs (replace, not merge)
    for sub in ("lineart-svg", "exp3/imageB", "exp3/imageC", "crops"):
        dst = PUBLIC / sub
        if dst.exists():
            shutil.rmtree(dst)
        src = base / sub
        if src.exists():
            shutil.copytree(src, dst)
    return True


def _kickoff_full(prompt: str, boxes_json: str) -> None:
    global _running
    env = os.environ.copy()
    env["ACCROCHE_PROMPT"] = prompt
    env["ACCROCHE_BOXES"] = boxes_json
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        subprocess.run(
            [sys.executable, str(PIPELINE_FULL)],
            env=env, cwd=str(ROOT),
        )
    finally:
        with _lock:
            _running = False


def _kickoff_master_only(prompt: str) -> None:
    global _running
    env = os.environ.copy()
    env["ACCROCHE_PROMPT"] = prompt
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        if MASTER_PATH.exists():
            MASTER_PATH.unlink()
        STATUS_FILE.write_text(json.dumps({
            "running": True, "step_index": 1, "total_steps": 1,
            "step": "Génération du master 2560x1440 (~30-60s)",
            "error": None, "prompt": prompt,
        }, indent=2), encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PIPELINE_BUILD), "--prompt", prompt],
            env=env, cwd=str(ROOT),
        )
        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": 1, "total_steps": 1,
            "step": "Master prêt" if proc.returncode == 0 else None,
            "error": None if proc.returncode == 0 else f"build.py exit {proc.returncode}",
            "prompt": prompt, "master_only": True,
        }, indent=2), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def _kickoff_upload(image_bytes: bytes) -> None:
    """Process uploaded image — pad to 2560x1440, outpaint via GPT, save as master.jpg."""
    global _running
    import tempfile
    EDIT_SCRIPT = ROOT / "pipeline" / "_imagegen" / "edit.py"
    OUTPAINT_PROMPT = (
        "Extend this image to fill the entire frame seamlessly. The white-padded areas "
        "must be replaced with a natural extension of the existing scene — same setting, "
        "same lighting, same perspective, same color palette, same photographic style. "
        "Preserve the original photographic content (the non-white area) exactly as it is — "
        "do not modify, recolor, or shift it. Only fill the masked white areas with content "
        "that flows organically from the visible photograph. "
        "If the original image is small or low-resolution, deliver a high-resolution result "
        "matching the requested output size with crisp natural detail. "
        "The final result must look like a single coherent photograph captured at this aspect "
        "ratio. No watermark, no text, no artificial seams."
    )
    try:
        STATUS_FILE.write_text(json.dumps({
            "running": True, "step_index": 1, "total_steps": 2,
            "step": "Préparation de l'image (centrée + masque)",
            "error": None,
        }, indent=2), encoding="utf-8")

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        src_w, src_h = img.size
        target_aspect = MASTER_W / MASTER_H
        src_aspect = src_w / src_h

        aspect_close = abs(src_aspect - target_aspect) < 0.03
        big_enough = src_w >= int(MASTER_W * 0.95) and src_h >= int(MASTER_H * 0.95)

        if aspect_close and big_enough:
            scaled = img.resize((MASTER_W, MASTER_H), Image.LANCZOS)
            scaled.save(MASTER_PATH, "JPEG", quality=85, optimize=True)
            STATUS_FILE.write_text(json.dumps({
                "running": False, "step_index": 2, "total_steps": 2,
                "step": "Master prêt (resize direct, pas de GPT nécessaire)",
                "error": None, "master_only": True,
            }, indent=2), encoding="utf-8")
            return

        scale = min(MASTER_W / src_w, MASTER_H / src_h)
        new_w = int(round(src_w * scale))
        new_h = int(round(src_h * scale))
        new_w -= new_w % 2
        new_h -= new_h % 2
        resized = img.resize((new_w, new_h), Image.LANCZOS)

        canvas = Image.new("RGB", (MASTER_W, MASTER_H), (255, 255, 255))
        pad_x = (MASTER_W - new_w) // 2
        pad_y = (MASTER_H - new_h) // 2
        canvas.paste(resized, (pad_x, pad_y))

        mask = Image.new("RGBA", (MASTER_W, MASTER_H), (0, 0, 0, 0))
        opaque = Image.new("RGBA", (new_w, new_h), (0, 0, 0, 255))
        mask.paste(opaque, (pad_x, pad_y))

        with tempfile.TemporaryDirectory() as tmp:
            padded_path = Path(tmp) / "padded.png"
            mask_path = Path(tmp) / "mask.png"
            canvas.save(padded_path)
            mask.save(mask_path)

            for ext in ("png", "jpg", "jpeg", "webp"):
                for stale in PUBLIC.glob(f"master*.{ext}"):
                    stale.unlink()

            STATUS_FILE.write_text(json.dumps({
                "running": True, "step_index": 2, "total_steps": 2,
                "step": "Outpainting via gpt-image-2 (~30-90s)",
                "error": None,
                "padding": {"x": pad_x, "y": pad_y, "w": new_w, "h": new_h},
            }, indent=2), encoding="utf-8")

            cmd = [
                sys.executable, str(EDIT_SCRIPT),
                "--image", str(padded_path),
                "--mask", str(mask_path),
                "--prompt", OUTPAINT_PROMPT,
                "--output", str(MASTER_PATH),
                "--size", f"{MASTER_W}x{MASTER_H}",
                "--quality", "medium",
                "--format", "jpeg",
            ]
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            proc = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8")
            if proc.returncode != 0:
                raise RuntimeError(f"edit.py failed: {proc.stderr.strip()[:400]}")
            actual = Path(proc.stdout.strip().splitlines()[-1])
            if actual.resolve() != MASTER_PATH.resolve():
                actual.rename(MASTER_PATH)

        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": 2, "total_steps": 2,
            "step": "Master prêt", "error": None, "master_only": True,
        }, indent=2), encoding="utf-8")
    except Exception as e:
        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": None, "total_steps": 2,
            "step": None, "error": str(e), "master_only": True,
        }, indent=2), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def _kickoff_regen_box(box: dict, opts: dict, scene_id: str | None) -> None:
    """Regenerate selected per-box assets, then optionally resnap into the scene."""
    global _running
    box_id = str(box.get("id"))
    try:
        labels = []
        if opts.get("imageB"): labels.append("zoom 1")
        if opts.get("imageC"): labels.append("zoom 2")
        if opts.get("dessin"): labels.append("dessin")
        STATUS_FILE.write_text(json.dumps({
            "running": True, "step_index": 1, "total_steps": 1,
            "step": f"Régénération cadre {box_id} ({', '.join(labels) or 'rien'})…",
            "error": None,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["ACCROCHE_BOX"] = json.dumps(box, ensure_ascii=False)
        env["ACCROCHE_OPTS"] = json.dumps(opts)
        proc = subprocess.run(
            [sys.executable, str(PIPELINE_REGEN_BOX)],
            env=env, cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            STATUS_FILE.write_text(json.dumps({
                "running": False, "step_index": None, "total_steps": 1,
                "step": None, "error": (proc.stderr or proc.stdout)[-400:],
            }, indent=2, ensure_ascii=False), encoding="utf-8")
            return
        # Re-snap into the scene if one is loaded so the saved module reflects the change.
        if scene_id and (SCENES_DIR / scene_id / "meta.json").exists():
            try:
                _resnap_scene(scene_id)
            except Exception as e:
                # Non-fatal: report the error but mark generation as done.
                STATUS_FILE.write_text(json.dumps({
                    "running": False, "step_index": 1, "total_steps": 1,
                    "step": "Régénéré (resnap échoué)", "error": str(e),
                }, indent=2, ensure_ascii=False), encoding="utf-8")
                return
        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": 1, "total_steps": 1,
            "step": "Régénération terminée", "error": None,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def _tunnel_status() -> dict:
    """Snapshot of the current tunnel state. Cleans up dead processes."""
    with _tunnel_lock:
        proc = _tunnel.get("process")
        if proc is not None and proc.poll() is not None:
            # Process has exited.
            _tunnel["process"] = None
            if not _tunnel.get("error"):
                _tunnel["error"] = f"cloudflared exited with code {proc.returncode}"
            _tunnel["url"] = None
        return {
            "running": _tunnel.get("process") is not None and _tunnel["process"].poll() is None,
            "url": _tunnel.get("url"),
            "started_at": _tunnel.get("started_at"),
            "error": _tunnel.get("error"),
            "cloudflared_path": CLOUDFLARED if Path(CLOUDFLARED).exists() else None,
        }


def _start_tunnel(port: int) -> dict:
    """Start a cloudflared quick tunnel pointing at this server. Idempotent."""
    with _tunnel_lock:
        if _tunnel.get("process") and _tunnel["process"].poll() is None:
            return _tunnel_status()
        if not Path(CLOUDFLARED).exists():
            _tunnel["error"] = (
                "cloudflared introuvable. Installe-le depuis "
                "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            )
            return _tunnel_status()
        try:
            proc = subprocess.Popen(
                [CLOUDFLARED, "tunnel", "--url", f"http://localhost:{port}",
                 "--no-autoupdate", "--logfile", str(ROOT / ".tunnel.log")],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            )
        except Exception as e:
            _tunnel["error"] = f"impossible de lancer cloudflared: {e}"
            return _tunnel_status()
        _tunnel["process"] = proc
        _tunnel["started_at"] = _now_iso()
        _tunnel["url"] = None
        _tunnel["error"] = None

    # Read its output in a daemon thread to capture the public URL.
    def _reader(p: subprocess.Popen) -> None:
        for line in iter(p.stdout.readline, ""):
            if not line:
                break
            m = _RE_TRYCF.search(line)
            if m:
                with _tunnel_lock:
                    _tunnel["url"] = m.group(0)
                # Don't break — keep draining so the pipe doesn't fill up.
        # Process ended.
        with _tunnel_lock:
            if not _tunnel.get("error") and p.returncode not in (0, None):
                _tunnel["error"] = f"cloudflared exited (code {p.returncode})"

    threading.Thread(target=_reader, args=(proc,), daemon=True).start()
    return _tunnel_status()


def _stop_tunnel() -> dict:
    with _tunnel_lock:
        proc = _tunnel.get("process")
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
            except Exception:
                pass
        _tunnel["process"] = None
        _tunnel["url"] = None
    return _tunnel_status()


def _kickoff_character_edit(rect: dict, mask_b64: str, prompt: str,
                            scene_id: str | None) -> None:
    """Édition pixel-par-masque d'une zone du master via gpt-image-2."""
    global _running
    import base64
    import tempfile
    try:
        STATUS_FILE.write_text(json.dumps({
            "running": True, "step_index": 1, "total_steps": 1,
            "step": "Édition par masque (~30-60s)…",
            "error": None,
        }, indent=2, ensure_ascii=False), encoding="utf-8")
        # Décode le PNG masque dans un fichier temporaire
        try:
            mask_bytes = base64.b64decode(mask_b64)
        except Exception as e:
            raise RuntimeError(f"masque base64 invalide : {e}")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
            tmp.write(mask_bytes)
            mask_path = tmp.name
        try:
            env = os.environ.copy()
            env["PYTHONIOENCODING"] = "utf-8"
            env["ACCROCHE_CHAR_RECT"] = json.dumps(rect)
            env["ACCROCHE_CHAR_PROMPT"] = prompt
            env["ACCROCHE_CHAR_MASK_PATH"] = mask_path
            proc = subprocess.run(
                [sys.executable, str(PIPELINE_CHAR_EDIT)],
                env=env, cwd=str(ROOT),
                capture_output=True, text=True, encoding="utf-8",
            )
            if proc.returncode != 0:
                err = (proc.stderr or proc.stdout)[-400:].strip()
                STATUS_FILE.write_text(json.dumps({
                    "running": False, "step_index": None, "total_steps": 1,
                    "step": None, "error": err or f"character_edit exit {proc.returncode}",
                }, indent=2, ensure_ascii=False), encoding="utf-8")
                return
            # Re-snap dans la scène si on en édite une
            if scene_id and (SCENES_DIR / scene_id / "meta.json").exists():
                try:
                    _resnap_scene(scene_id)
                except Exception as e:
                    STATUS_FILE.write_text(json.dumps({
                        "running": False, "step_index": 1, "total_steps": 1,
                        "step": "Master édité (resnap échoué)", "error": str(e),
                    }, indent=2, ensure_ascii=False), encoding="utf-8")
                    return
            STATUS_FILE.write_text(json.dumps({
                "running": False, "step_index": 1, "total_steps": 1,
                "step": "Édition par masque terminée", "error": None,
            }, indent=2, ensure_ascii=False), encoding="utf-8")
        finally:
            try: Path(mask_path).unlink(missing_ok=True)
            except OSError: pass
    except Exception as e:
        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": None, "total_steps": 1,
            "step": None, "error": str(e),
        }, indent=2, ensure_ascii=False), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def _kickoff_quest_gen(scene_id: str, quest_id: str) -> None:
    global _running
    try:
        STATUS_FILE.write_text(json.dumps({
            "running": True, "step_index": 1, "total_steps": 2,
            "step": f"Génération images de la quête {quest_id}…",
            "error": None,
        }, indent=2), encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, str(PIPELINE_QUEST), "--scene", scene_id, "--quest", quest_id],
            env=env, cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            STATUS_FILE.write_text(json.dumps({
                "running": False, "step_index": None, "total_steps": 2,
                "step": None, "error": (proc.stderr or proc.stdout)[:400],
            }, indent=2), encoding="utf-8")
            return
        STATUS_FILE.write_text(json.dumps({
            "running": False, "step_index": 2, "total_steps": 2,
            "step": "Quête prête", "error": None,
        }, indent=2), encoding="utf-8")
    finally:
        with _lock:
            _running = False


def _parse_multipart(body: bytes, content_type: str) -> dict[str, bytes]:
    headers = (
        b"Content-Type: " + content_type.encode("utf-8") + b"\r\n\r\n"
    )
    msg = BytesParser(policy=default_policy).parsebytes(headers + body)
    parts: dict[str, bytes] = {}
    for part in msg.iter_parts():
        disp = part.get("Content-Disposition", "")
        name = None
        for chunk in disp.split(";"):
            chunk = chunk.strip()
            if chunk.startswith('name="'):
                name = chunk[6:-1]
                break
        if name:
            payload = part.get_payload(decode=True)
            parts[name] = payload if isinstance(payload, (bytes, bytearray)) else b""
    return parts


# Match URL paths like /api/scenes/<id> or /api/scenes/<id>/load
_RE_SCENE = re.compile(r"^/api/scenes/([^/]+)(/(load|meta|resnap|delete|history|history/restore|generate|generate-quest|rate|rate-quest|regen-distractor|draft-feedback|quest/[^/]+/generate))?$")


def _png_size(path: Path) -> tuple[int, int] | None:
    """Lit la taille d'un PNG/JPG sans charger l'image entière en mémoire."""
    if not path.exists():
        return None
    try:
        from PIL import Image as _Img
        with _Img.open(path) as im:
            return im.size
    except Exception:
        return None


def _debug_box_info(box_id: str, scene_id: str | None = None) -> dict:
    """Renvoie tout ce qu'il faut pour comprendre où un tracé se positionne :
    geom (crop_in_master + target_size), tailles RÉELLES de chaque artefact,
    URLs des fichiers à afficher dans debug.html."""
    if scene_id:
        base = SCENES_DIR / scene_id
        public_prefix = f"scenes/{scene_id}"
    else:
        base = PUBLIC
        public_prefix = ""
    crops = base / "crops"
    lineart_svg = base / "lineart-svg"
    geom_path = crops / f"box-{box_id}-geom.json"
    geom = _read_json(geom_path, None)

    paths_for = {
        "input": crops / f"box-{box_id}-input.png",
        "raw":   crops / f"box-{box_id}-raw.png",
        "line":  crops / f"box-{box_id}-line.png",
        "skel":  lineart_svg / f"box-{box_id}-skel.svg",
    }
    artifacts = {}
    for k, p in paths_for.items():
        size = _png_size(p) if k != "skel" else None
        st = p.stat() if p.exists() else None
        artifacts[k] = {
            "exists": p.exists(),
            "url": (f"/{public_prefix}/" if public_prefix else "/") + p.relative_to(base if public_prefix else PUBLIC).as_posix(),
            "real_size": {"w": size[0], "h": size[1]} if size else None,
            "bytes": st.st_size if st else None,
            "mtime": st.st_mtime if st else None,
        }

    # Master
    master_path = (base / (geom.get("master_filename") if geom and geom.get("master_filename") else "master.jpg"))
    if not master_path.exists():
        master_path = base / "master.jpg"
    master_size = _png_size(master_path)

    # Cherche le box correspondant dans boxes.json (ou meta.json pour scene)
    if scene_id:
        meta = _scene_meta(scene_id) or {}
        boxes = meta.get("boxes", [])
    else:
        boxes = _read_json(BOXES_FILE, [])
    box = next((b for b in boxes if str(b.get("id")) == str(box_id)), None)

    return {
        "box_id": box_id,
        "scene_id": scene_id,
        "box": box,
        "master": {
            "url": (f"/{public_prefix}/" if public_prefix else "/") + master_path.name,
            "real_size": {"w": master_size[0], "h": master_size[1]} if master_size else None,
        },
        "geom": geom,
        "artifacts": artifacts,
    }


HISTORY_MAX = 10
# Sous-dossiers à snapshoter pour le backup auto. Couvre master + tracés
# (lineart-svg) + images zoom (imageB / imageC). Les crops/ ne sont pas
# inclus volontairement : ils sont régénérables et lourds.
HISTORY_FILES = ["master.jpg", "master.png", "lineart-svg", "exp3/imageB", "exp3/imageC", "boxes.json"]


def _backup_scene_dir(scene_id: str) -> str | None:
    """Snapshot l'état courant des artefacts générés (avant écrasement par
    le prochain resnap / character_edit). Stocke dans
    `scenes/<sid>/.history/<timestamp>/<relpath>`. Garde les 10 derniers.

    Renvoie le timestamp du snapshot créé, ou None si rien à sauvegarder.
    """
    base = SCENES_DIR / scene_id
    if not base.exists():
        return None
    # Timestamp ISO sans : ni - dans le nom (compatible filesystem)
    ts = _now_iso().replace(":", "").replace("-", "")
    history_dir = base / ".history" / ts
    something_saved = False
    for rel in HISTORY_FILES:
        src = base / rel
        if not src.exists():
            continue
        dst = history_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
            something_saved = True
        except Exception:
            continue
    if not something_saved:
        return None
    # Rotation : garde les HISTORY_MAX plus récents
    history_root = base / ".history"
    if history_root.exists():
        entries = sorted(
            [p for p in history_root.iterdir() if p.is_dir()],
            reverse=True,
        )
        for old in entries[HISTORY_MAX:]:
            shutil.rmtree(old, ignore_errors=True)
    return ts


def _list_scene_history(scene_id: str) -> list[dict]:
    """Liste les snapshots d'historique d'une scène, du plus récent au plus
    ancien. Chaque entrée : { timestamp, label, files: [rel, …] }."""
    base = SCENES_DIR / scene_id
    history_root = base / ".history"
    if not history_root.exists():
        return []
    out: list[dict] = []
    for entry in sorted(history_root.iterdir(), reverse=True):
        if not entry.is_dir():
            continue
        files: list[str] = []
        for p in entry.rglob("*"):
            if p.is_file():
                files.append(str(p.relative_to(entry)).replace("\\", "/"))
        # Label humain : "11 mai · 23:32"
        ts = entry.name
        try:
            # ts = "20260511T133222.123" → parse
            year = ts[0:4]; month = ts[4:6]; day = ts[6:8]
            hour = ts[9:11]; mn = ts[11:13]
            label = f"{day}/{month} · {hour}:{mn}"
        except Exception:
            label = ts
        out.append({"timestamp": ts, "label": label, "files": files})
    return out


def _restore_scene_history(scene_id: str, timestamp: str) -> bool:
    """Restaure tous les fichiers d'un snapshot dans le scene dir, ÉCRASANT
    l'état courant. Avant de restaurer, on snapshot l'état courant pour
    pouvoir undo le undo si besoin."""
    base = SCENES_DIR / scene_id
    history_root = base / ".history"
    snap = history_root / timestamp
    if not snap.exists() or not snap.is_dir():
        return False
    # Snapshot CURRENT before restoring (safety net : on peut revenir
    # à l'état pré-restore en restaurant le tout dernier snapshot).
    _backup_scene_dir(scene_id)
    # Restore : pour chaque fichier/dossier dans le snapshot, on remplace
    # le pendant courant dans la scène.
    for rel in HISTORY_FILES:
        src = snap / rel
        if not src.exists():
            continue
        dst = base / rel
        if dst.exists():
            if dst.is_dir():
                shutil.rmtree(dst, ignore_errors=True)
            else:
                dst.unlink()
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        except Exception:
            return False
    # Met aussi à jour public/ si le scene est actuellement chargé pour
    # édition : on relance _restore_scene qui copie scenes/<sid>/* vers public/*.
    _restore_scene(scene_id)
    return True


def _resnap_scene(scene_id: str) -> dict | None:
    """Replace asset folders + boxes in the saved scene with current public/ state.
    Preserves name, category, level1_questions, quests, created_at."""
    base = SCENES_DIR / scene_id
    meta = _scene_meta(scene_id)
    if not meta:
        return None

    # Backup auto AVANT écrasement (10 derniers snapshots gardés)
    _backup_scene_dir(scene_id)

    # master
    master_src = MASTER_PATH if MASTER_PATH.exists() else (PUBLIC / "master.png")
    if master_src.exists():
        # Wipe any prior master files in the scene dir
        for ext in ("jpg", "jpeg", "png", "webp"):
            for stale in base.glob(f"master.{ext}"):
                stale.unlink()
        shutil.copy2(master_src, base / master_src.name)
        meta["master_filename"] = master_src.name

    # boxes
    boxes = _read_json(BOXES_FILE, [])
    meta["boxes"] = boxes
    meta["box_count"] = len(boxes)

    # asset dirs
    for sub in ("lineart-svg", "exp3/imageB", "exp3/imageC", "crops"):
        dst = base / sub
        if dst.exists():
            shutil.rmtree(dst)
        src = PUBLIC / sub
        if src.exists():
            shutil.copytree(src, dst)

    meta["updated_at"] = _now_iso()
    _write_json(base / "meta.json", meta)
    _write_json(base / "boxes.json", boxes)
    return meta


def _annotate_quest_images(scene_id: str, meta: dict) -> dict:
    """Mark each quest with _has_images=True if both image1.jpg and image2.jpg exist."""
    base = SCENES_DIR / scene_id
    quests = meta.get("quests", [])
    for q in quests:
        qid = str(q.get("id"))
        d = base / "quests" / qid
        q["_has_images"] = (d / "image1.jpg").exists() and (d / "image2.jpg").exists()
    return meta


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def _read_json(self) -> dict | None:
        body = self._read_body()
        # Décodage tolérant : utf-8 d'abord (cas normal du frontend JS),
        # puis fallback latin-1 + remplacement pour les bodies venant de
        # shells / curl qui ne signalent pas l'encoding. Évite que le
        # serveur crashe (502) sur un caractère accentué mal encodé.
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            text = body.decode("utf-8", errors="replace")
        try:
            return json.loads(text or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"error": "invalid JSON"})
            return None

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/api/status":
            data = {"running": _running, "step": None, "error": None}
            if STATUS_FILE.exists():
                try:
                    data = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
                except Exception:
                    pass
            with _lock:
                data["running"] = _running or data.get("running", False)
            self._send_json(200, data)
            return
        if path == "/api/boxes":
            boxes = _read_json(BOXES_FILE, [])
            self._send_json(200, {"boxes": boxes})
            return
        if path == "/api/share/status":
            self._send_json(200, _tunnel_status())
            return

        # Catalogue de personas clients luxe (lecture seule).
        # Servi tel quel depuis data/client_personas.json.
        if path == "/api/personas":
            personas_file = ROOT / "data" / "client_personas.json"
            if not personas_file.exists():
                self._send_json(404, {"error": "personas catalog not found"})
                return
            try:
                data = json.loads(personas_file.read_text(encoding="utf-8"))
            except Exception as e:
                self._send_json(500, {"error": f"personas parse: {e}"})
                return
            self._send_json(200, data)
            return
        # Debug : agrège pour un cadre toutes les métadonnées du pipeline
        # lineart (geom + tailles RÉELLES de chaque PNG + chemin de chaque
        # artefact). Permet à debug.html de tout afficher d'un coup.
        if path.startswith("/api/debug/box/"):
            box_id = path[len("/api/debug/box/"):]
            scene_id = None
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            for kv in qs.split("&"):
                if kv.startswith("scene="):
                    scene_id = kv.split("=", 1)[1]
            self._send_json(200, _debug_box_info(box_id, scene_id))
            return
        if path == "/api/scenes":
            out = []
            for sid in _list_scene_ids():
                m = _scene_meta(sid) or {}
                out.append({
                    "id": m.get("id", sid),
                    "name": m.get("name", sid),
                    "category": m.get("category", ""),
                    "created_at": m.get("created_at"),
                    "updated_at": m.get("updated_at"),
                    "box_count": m.get("box_count", len(m.get("boxes", []))),
                    "level1_count": len(m.get("level1_questions", [])),
                    "quest_count": len(m.get("quests", [])),
                    "master_url": f"scenes/{sid}/{m.get('master_filename') or 'master.jpg'}",
                })
            self._send_json(200, {"scenes": out})
            return
        m = _RE_SCENE.match(path)
        if m and not m.group(2):
            sid = m.group(1)
            meta = _scene_meta(sid)
            if not meta:
                self._send_json(404, {"error": "scene not found"})
                return
            _annotate_quest_images(sid, meta)
            self._send_json(200, meta)
            return
        # GET /api/scenes/<id>/history → liste des snapshots
        if m and m.group(3) == "history":
            sid = m.group(1)
            base = SCENES_DIR / sid
            if not base.exists():
                self._send_json(404, {"error": "scene not found"})
                return
            self._send_json(200, {"history": _list_scene_history(sid)})
            return
        super().do_GET()

    def do_DELETE(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        m = _RE_SCENE.match(path)
        if m and not m.group(2):
            sid = m.group(1)
            base = SCENES_DIR / sid
            if not base.exists():
                self._send_json(404, {"error": "scene not found"})
                return
            shutil.rmtree(base)
            self._send_json(200, {"deleted": sid})
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        global _running
        path = self.path.split("?")[0]

        if path == "/api/master/upload":
            ctype = self.headers.get("Content-Type", "")
            body = self._read_body()
            try:
                parts = _parse_multipart(body, ctype) if "multipart" in ctype else {"image": body}
                image = parts.get("image")
                if not image:
                    self._send_json(400, {"error": "no image field"})
                    return
            except Exception as e:
                self._send_json(400, {"error": f"upload parse failed: {e}"})
                return
            with _lock:
                if _running:
                    self._send_json(409, {"error": "generation already in progress"})
                    return
                _running = True
            threading.Thread(target=_kickoff_upload, args=(image,), daemon=True).start()
            self._send_json(202, {"started": True})
            return

        if path == "/api/master/generate":
            payload = self._read_json()
            if payload is None: return
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                self._send_json(400, {"error": "prompt required"})
                return
            with _lock:
                if _running:
                    self._send_json(409, {"error": "generation already in progress"})
                    return
                _running = True
            threading.Thread(target=_kickoff_master_only, args=(prompt,), daemon=True).start()
            self._send_json(202, {"started": True})
            return

        if path == "/api/boxes":
            payload = self._read_json()
            if payload is None: return
            boxes = payload.get("boxes")
            if not isinstance(boxes, list):
                self._send_json(400, {"error": "boxes must be a list"})
                return
            _write_json(BOXES_FILE, boxes)
            self._send_json(200, {"saved": len(boxes)})
            return

        if path == "/api/generate":
            payload = self._read_json()
            if payload is None: return
            boxes = payload.get("boxes")
            if not isinstance(boxes, list) or not boxes:
                self._send_json(400, {"error": "at least one box required"})
                return
            _write_json(BOXES_FILE, boxes)
            with _lock:
                if _running:
                    self._send_json(409, {"error": "generation already in progress"})
                    return
                _running = True
            prompt = payload.get("prompt") or ""
            threading.Thread(
                target=_kickoff_full,
                args=(prompt, json.dumps(boxes)),
                daemon=True,
            ).start()
            self._send_json(202, {"started": True})
            return

        if path == "/api/share/start":
            port = int(os.environ.get("PORT", "8000"))
            st = _start_tunnel(port)
            # Allow ~6s for the URL to appear (cloudflared usually prints it within 2-4s).
            import time as _t
            for _ in range(60):
                if st.get("url") or st.get("error"):
                    break
                _t.sleep(0.1)
                st = _tunnel_status()
            self._send_json(200, st)
            return

        if path == "/api/share/stop":
            self._send_json(200, _stop_tunnel())
            return

        # Régénère les descriptions vision factuelles de TOUS les cadres
        # d'une scène (ou de toutes les scènes si scene_ids omis).
        # Body : { scene_ids?: [string], force?: bool }
        if path == "/api/describe-boxes":
            payload = self._read_json() or {}
            sids = payload.get("scene_ids")
            force = bool(payload.get("force", False))
            try:
                sys.path.insert(0, str(ROOT / "pipeline"))
                from generate import describe_all_boxes  # noqa
                if not sids:
                    sids = [p.name for p in SCENES_DIR.iterdir() if p.is_dir() and (p / "meta.json").exists()]
                report = {}
                for sid in sids:
                    try:
                        report[sid] = describe_all_boxes(sid, force=force)
                    except Exception as e:
                        report[sid] = {"error": str(e)}
            except Exception as e:
                self._send_json(500, {"error": f"describe failed: {e}"}); return
            self._send_json(200, {"report": report})
            return

        # Bootstrap du corpus : transforme chaque question/quête déjà
        # présente dans les modules en entrées corrections "good" (avec
        # embeddings), pour amorcer le RAG. Idempotent — skip les items
        # déjà bootstrappés. Renvoie un rapport par scène.
        if path == "/api/bootstrap-corpus":
            payload = self._read_json() or {}
            scene_ids = payload.get("scene_ids") or None
            try:
                sys.path.insert(0, str(ROOT / "pipeline"))
                from generate import bootstrap_corpus  # noqa
                report = bootstrap_corpus(scene_ids)
            except Exception as e:
                self._send_json(500, {"error": f"bootstrap failed: {e}"}); return
            self._send_json(200, {"report": report})
            return

        # Refinement du prompt système (N1 ou N2) : GPT relit corrections
        # accumulées + prompt actuel → produit nouvelle version + archive.
        if path == "/api/refine-prompt":
            payload = self._read_json()
            if payload is None: return
            try:
                level = int(payload.get("level", 1))
            except Exception:
                self._send_json(400, {"error": "level requis"}); return
            if level not in (1, 2):
                self._send_json(400, {"error": "level must be 1 or 2"}); return
            try:
                sys.path.insert(0, str(ROOT / "pipeline"))
                from generate import refine_prompt  # noqa
                result = refine_prompt(level)
            except Exception as e:
                self._send_json(500, {"error": f"refine failed: {e}"}); return
            self._send_json(200, result)
            return

        if path == "/api/character-edit":
            payload = self._read_json()
            if payload is None: return
            rect = payload.get("rect")
            mask_b64 = payload.get("mask_png_b64")
            prompt = (payload.get("prompt") or "").strip()
            scene_id = payload.get("scene_id")
            if not isinstance(rect, dict) or not all(k in rect for k in ("x", "y", "w", "h")):
                self._send_json(400, {"error": "rect {x,y,w,h} requis"}); return
            if not mask_b64:
                self._send_json(400, {"error": "mask_png_b64 requis"}); return
            if not prompt:
                self._send_json(400, {"error": "prompt requis"}); return
            with _lock:
                if _running:
                    self._send_json(409, {"error": "génération déjà en cours"})
                    return
                _running = True
            threading.Thread(
                target=_kickoff_character_edit,
                args=(rect, mask_b64, prompt, scene_id),
                daemon=True,
            ).start()
            self._send_json(202, {"started": True})
            return

        if path == "/api/regen-box":
            payload = self._read_json()
            if payload is None: return
            box = payload.get("box")
            opts = payload.get("opts") or {}
            scene_id = payload.get("scene_id")
            if not isinstance(box, dict) or "id" not in box:
                self._send_json(400, {"error": "box (with id) required"})
                return
            if not (opts.get("imageB") or opts.get("imageC") or opts.get("dessin")):
                self._send_json(400, {"error": "select at least one asset to regenerate"})
                return
            with _lock:
                if _running:
                    self._send_json(409, {"error": "generation already in progress"})
                    return
                _running = True
            threading.Thread(
                target=_kickoff_regen_box, args=(box, opts, scene_id), daemon=True
            ).start()
            self._send_json(202, {"started": True})
            return

        if path == "/api/scenes":
            # Save current public/ as a scene.
            payload = self._read_json()
            if payload is None: return
            name = (payload.get("name") or "").strip()
            if not name:
                self._send_json(400, {"error": "name required"})
                return
            category = (payload.get("category") or "").strip()
            if not MASTER_PATH.exists() and not (PUBLIC / "master.png").exists():
                self._send_json(400, {"error": "no master image to snapshot"})
                return
            try:
                meta = _snapshot_current_scene(name, category)
            except Exception as e:
                self._send_json(500, {"error": str(e)})
                return
            self._send_json(201, {"scene": meta})
            return

        # /api/scenes/<id>/load OR /load OR /meta OR /quest/<qid>/generate
        m = _RE_SCENE.match(path)
        if m:
            sid = m.group(1)
            sub = m.group(3) or ""
            base = SCENES_DIR / sid
            if not base.exists():
                self._send_json(404, {"error": "scene not found"})
                return

            if sub == "load":
                ok = _restore_scene(sid)
                if not ok:
                    self._send_json(500, {"error": "restore failed"})
                    return
                self._send_json(200, {"loaded": sid})
                return

            if sub == "history/restore":
                payload = self._read_json()
                if payload is None: return
                ts = (payload.get("timestamp") or "").strip()
                if not ts:
                    self._send_json(400, {"error": "timestamp required"})
                    return
                ok = _restore_scene_history(sid, ts)
                if not ok:
                    self._send_json(500, {"error": "history restore failed"})
                    return
                self._send_json(200, {"restored": ts})
                return

            # ===== Génération assistée + notation =====
            if sub == "generate":
                # Body : {level: 1|2, count: int, per_box?: bool}
                payload = self._read_json()
                if payload is None: return
                try:
                    level = int(payload.get("level", 1))
                    count = int(payload.get("count", 4))
                    per_box = bool(payload.get("per_box", False))
                except Exception:
                    self._send_json(400, {"error": "level/count invalides"}); return
                if level not in (1, 2):
                    self._send_json(400, {"error": "level must be 1 or 2"}); return
                if count < 1 or count > 20:
                    self._send_json(400, {"error": "count must be 1..20"}); return
                # Import paresseux pour ne pas bloquer le démarrage si chat n'est pas configuré
                try:
                    sys.path.insert(0, str(ROOT / "pipeline"))
                    from generate import generate_n1_questions, generate_n2_quests  # noqa
                except Exception as e:
                    self._send_json(500, {"error": f"pipeline import: {e}"}); return
                try:
                    if level == 1:
                        items = generate_n1_questions(sid, count)
                        key = "level1_questions"
                    else:
                        items = generate_n2_quests(sid, count, per_box=per_box)
                        key = "quests"
                except Exception as e:
                    self._send_json(500, {"error": f"generation failed: {e}"})
                    return
                # Append to meta
                meta = _scene_meta(sid) or {}
                meta.setdefault(key, []).extend(items)
                meta["updated_at"] = _now_iso()
                _write_json(base / "meta.json", meta)
                self._send_json(200, {"added": len(items), "items": items})
                return

            # Génère UNE quête N2 pour un cadre précis (vision sur l'image
            # du cadre + description automatique). Renvoie la quête PAYLOAD
            # mais ne la persiste PAS — l'éditeur la reçoit, la pré-remplit
            # dans son modal d'édition où l'utilisateur peut noter et sauver.
            if sub == "generate-quest":
                payload = self._read_json()
                if payload is None: return
                box_id = (payload.get("box_id") or "").strip()
                if not box_id:
                    self._send_json(400, {"error": "box_id requis"}); return
                try:
                    sys.path.insert(0, str(ROOT / "pipeline"))
                    from generate import generate_one_quest_for_box  # noqa
                    quest = generate_one_quest_for_box(sid, box_id)
                except Exception as e:
                    self._send_json(500, {"error": f"generation failed: {e}"}); return
                self._send_json(200, {"quest": quest})
                return

            # Sauvegarde groupée des ratings PAR CHAMP d'une quête depuis le
            # modal d'édition. Payload :
            #   {
            #     item_id, box_id, box_subject, box_description,
            #     quest_title, intro_text,
            #     title_rating?: { rating, note, label },
            #     intro_rating?: { rating, note, label },
            #     choices: [
            #       { idx, text, is_best, explanation,
            #         text_rating?: { rating, note, label },
            #         explain_rating?: { rating, note, label }
            #       }, ...
            #     ]
            #   }
            # Chaque rating non-null produit une entrée corrections_n2.txt
            # avec son kind (field_title / field_intro / field_choice_text /
            # field_choice_explain) + le contexte cadre complet.
            if sub == "rate-quest":
                payload = self._read_json()
                if payload is None: return
                item_id = (payload.get("item_id") or "").strip()
                box_id = str(payload.get("box_id") or "")
                box_subject = (payload.get("box_subject") or "").strip()
                box_description = (payload.get("box_description") or "").strip()
                quest_title = (payload.get("quest_title") or "").strip()
                intro_text = (payload.get("intro_text") or "").strip()
                # Récupère les facettes structurées du cadre depuis meta.boxes
                # (_analysis posé par describe_box) pour enrichir le contexte
                # injecté dans les corrections (DISC + niveau social + code luxe
                # → matches RAG plus précis sur la dimension client).
                meta_now = _scene_meta(sid) or {}
                box_obj = next((b for b in meta_now.get("boxes", [])
                                if str(b.get("id")) == box_id), None)
                analysis = (box_obj or {}).get("_analysis", {}) if box_obj else {}
                first_perso = (analysis.get("personnages") or [{}])[0]
                from pipeline.generate import append_correction  # noqa
                base_entry = {
                    "scene": sid, "level": 2,
                    "box_id": box_id,
                    "box_subject": box_subject,
                    "box_description": box_description,
                    "quest_title": quest_title,
                    "intro_text": intro_text,
                    "niveau_social": first_perso.get("niveau_social_estime", ""),
                    "disc_profile": first_perso.get("disc_profile_estime", ""),
                    "code_luxe": first_perso.get("code_luxe_lu", ""),
                }
                def _entry(kind, *, content=None, is_best=None, rate_blob=None):
                    if not rate_blob or not rate_blob.get("rating"):
                        return
                    e = dict(base_entry)
                    e["date"] = _now_iso()
                    e["kind"] = kind
                    e["rating"] = rate_blob.get("rating")
                    if rate_blob.get("label"):
                        e["rating_label"] = rate_blob["label"]
                    if content is not None:
                        e["content"] = content
                    if is_best is not None:
                        e["is_best"] = bool(is_best)
                    note = (rate_blob.get("note") or "").strip()
                    if note:
                        e["note"] = note
                    append_correction(2, e)
                _entry("field_title", content=quest_title, rate_blob=payload.get("title_rating"))
                _entry("field_intro", content=intro_text, rate_blob=payload.get("intro_rating"))
                for c in (payload.get("choices") or []):
                    _entry("field_choice_text",
                           content=c.get("text",""), is_best=c.get("is_best"),
                           rate_blob=c.get("text_rating"))
                    _entry("field_choice_explain",
                           content=c.get("explanation",""), is_best=c.get("is_best"),
                           rate_blob=c.get("explain_rating"))
                # Met à jour aussi meta avec les _field_ratings pour réafficher
                # à la prochaine ouverture du modal.
                meta = _scene_meta(sid) or {}
                target = next((x for x in meta.get("quests", []) if x.get("id") == item_id), None)
                if target:
                    fr = {}
                    if payload.get("title_rating", {}).get("rating"):
                        fr["title"] = {"rating": payload["title_rating"]["rating"],
                                       "note": payload["title_rating"].get("note")}
                    if payload.get("intro_rating", {}).get("rating"):
                        fr["intro"] = {"rating": payload["intro_rating"]["rating"],
                                       "note": payload["intro_rating"].get("note")}
                    if fr: target["_field_ratings"] = fr
                    target_choices = target.get("dialogue_choices", [])
                    for c in (payload.get("choices") or []):
                        idx = c.get("idx")
                        if not isinstance(idx, int) or not (0 <= idx < len(target_choices)):
                            continue
                        cfr = {}
                        if c.get("text_rating", {}).get("rating"):
                            cfr["text"] = {"rating": c["text_rating"]["rating"],
                                           "note": c["text_rating"].get("note")}
                        if c.get("explain_rating", {}).get("rating"):
                            cfr["explanation"] = {"rating": c["explain_rating"]["rating"],
                                                  "note": c["explain_rating"].get("note")}
                        if cfr:
                            target_choices[idx]["_field_ratings"] = cfr
                    meta["updated_at"] = _now_iso()
                    _write_json(base / "meta.json", meta)
                self._send_json(200, {"saved": True})
                return

            if sub == "rate":
                # Body : {level, item_id, kind: 'question'|'quest'|'answer',
                #         rating: 'good'|'nuanced'|'refused', note?, answer_idx?}
                payload = self._read_json()
                if payload is None: return
                level = int(payload.get("level", 1))
                item_id = (payload.get("item_id") or "").strip()
                kind = (payload.get("kind") or "").strip()
                rating = (payload.get("rating") or "").strip()
                note = (payload.get("note") or "").strip()
                answer_idx = payload.get("answer_idx")
                if rating not in ("good", "nuanced", "refused"):
                    self._send_json(400, {"error": "rating invalide"}); return
                # Note maintenant OPTIONNELLE pour TOUS les ratings — le rating
                # seul + le contexte (texte de l'item + cadre) est déjà utile
                # pour le fichier corrections, même sans le « pourquoi ».
                meta = _scene_meta(sid) or {}
                meta_key = "level1_questions" if level == 1 else "quests"
                items = meta.get(meta_key, [])
                target = next((x for x in items if x.get("id") == item_id), None)
                if not target:
                    self._send_json(404, {"error": "item_id introuvable"}); return
                # Application du rating
                from pipeline.generate import append_correction  # noqa
                if kind in ("question", "quest"):
                    target["_rating"] = rating
                    target["_note"] = note or None
                    # Append au fichier corrections
                    entry = {
                        "date": _now_iso(),
                        "scene": sid,
                        "level": level,
                        "kind": "question" if level == 1 else "quest",
                        "rating": rating,
                    }
                    if level == 1:
                        entry["question"] = target.get("text")
                        choices = target.get("choices", [])
                        ci = target.get("correct_index", 0)
                        entry["choices"] = "\n".join(
                            f"  - [{('correct' if i == ci else 'distractor')}] {c}"
                            for i, c in enumerate(choices))
                    else:
                        entry["quest_title"] = target.get("title")
                        entry["intro_text"] = target.get("intro_text")
                        choices = target.get("dialogue_choices", [])
                        entry["choices"] = "\n".join(
                            f"  - [{('best' if c.get('is_best') else 'alt')}] {c.get('text','')}"
                            for c in choices)
                    if note:
                        entry["note"] = note
                    append_correction(level, entry)
                elif kind == "answer":
                    if answer_idx is None:
                        self._send_json(400, {"error": "answer_idx requis"}); return
                    answer_idx = int(answer_idx)
                    if level == 1:
                        choices = target.get("choices", [])
                        if not (0 <= answer_idx < len(choices)):
                            self._send_json(400, {"error": "answer_idx hors borne"}); return
                        ratings = target.setdefault("_choice_ratings", [None] * len(choices))
                        while len(ratings) < len(choices):
                            ratings.append(None)
                        ratings[answer_idx] = {"rating": rating, "note": note or None}
                        ci = target.get("correct_index", 0)
                        is_correct = (answer_idx == ci)
                        entry = {
                            "date": _now_iso(), "scene": sid, "level": 1,
                            "kind": "answer", "rating": rating,
                            "parent_question": target.get("text"),
                            "answer": choices[answer_idx],
                            "is_correct_in_qcm": is_correct,
                        }
                    else:
                        choices = target.get("dialogue_choices", [])
                        if not (0 <= answer_idx < len(choices)):
                            self._send_json(400, {"error": "answer_idx hors borne"}); return
                        c = choices[answer_idx]
                        c["_rating"] = rating
                        c["_note"] = note or None
                        entry = {
                            "date": _now_iso(), "scene": sid, "level": 2,
                            "kind": "answer", "rating": rating,
                            "parent_quest": target.get("title"),
                            "answer": c.get("text"),
                            "is_best": bool(c.get("is_best")),
                        }
                    if note:
                        entry["note"] = note
                    append_correction(level, entry)
                elif kind == "explanation":
                    # Note sur l'explication globale d'une question N1
                    target["_explanation_rating"] = {"rating": rating, "note": note or None}
                    entry = {
                        "date": _now_iso(), "scene": sid, "level": level,
                        "kind": "explanation", "rating": rating,
                        "parent_question": target.get("text"),
                        "explanation": target.get("explanation"),
                    }
                    if note:
                        entry["note"] = note
                    append_correction(level, entry)
                else:
                    self._send_json(400, {"error": "kind doit être question|quest|answer|explanation"}); return
                meta["updated_at"] = _now_iso()
                _write_json(base / "meta.json", meta)
                self._send_json(200, {"rated": True})
                return

            if sub == "regen-distractor":
                # Body : {level, item_id, choice_idx, reason}
                payload = self._read_json()
                if payload is None: return
                level = int(payload.get("level", 1))
                item_id = (payload.get("item_id") or "").strip()
                choice_idx = int(payload.get("choice_idx", -1))
                reason = (payload.get("reason") or "").strip()
                if not reason:
                    self._send_json(400, {"error": "reason requise"}); return
                meta = _scene_meta(sid) or {}
                meta_key = "level1_questions" if level == 1 else "quests"
                target = next((x for x in meta.get(meta_key, []) if x.get("id") == item_id), None)
                if not target:
                    self._send_json(404, {"error": "item_id introuvable"}); return
                try:
                    sys.path.insert(0, str(ROOT / "pipeline"))
                    from generate import regen_distractor, append_correction  # noqa
                except Exception as e:
                    self._send_json(500, {"error": f"pipeline import: {e}"}); return
                if level == 1:
                    choices = target.get("choices", [])
                    if not (0 <= choice_idx < len(choices)):
                        self._send_json(400, {"error": "choice_idx hors borne"}); return
                    refused_text = choices[choice_idx]
                    try:
                        new_choice = regen_distractor(1, target, refused_text, reason)
                    except Exception as e:
                        self._send_json(500, {"error": f"regen failed: {e}"}); return
                    choices[choice_idx] = new_choice.get("text", "(régénéré)")
                else:
                    choices = target.get("dialogue_choices", [])
                    if not (0 <= choice_idx < len(choices)):
                        self._send_json(400, {"error": "choice_idx hors borne"}); return
                    refused_text = choices[choice_idx].get("text", "")
                    try:
                        new_choice = regen_distractor(2, target, refused_text, reason)
                    except Exception as e:
                        self._send_json(500, {"error": f"regen failed: {e}"}); return
                    choices[choice_idx] = {
                        "text": new_choice.get("text", ""),
                        "is_best": False,
                        "explanation": new_choice.get("explanation", ""),
                    }
                # Append correction du distracteur refusé pour nourrir les prompts
                append_correction(level, {
                    "date": _now_iso(), "scene": sid, "level": level,
                    "kind": "answer", "rating": "refused",
                    "answer": refused_text,
                    "note": reason,
                    "auto_regenerated": True,
                })
                meta["updated_at"] = _now_iso()
                _write_json(base / "meta.json", meta)
                self._send_json(200, {"new_choice": new_choice})
                return

            if sub == "draft-feedback":
                # Body : {type: 'question'|'quest', id, text, was_good: bool, comment}
                payload = self._read_json()
                if payload is None: return
                entry_type = (payload.get("type") or "").strip()
                tid = (payload.get("id") or "").strip()
                text = (payload.get("text") or "").strip()
                was_good = bool(payload.get("was_good", False))
                comment = (payload.get("comment") or "").strip()
                # Append à data/retour_draft.txt (PAS à corrections — c'est pour l'auteur)
                draft_file = ROOT / "data" / "retour_draft.txt"
                draft_file.parent.mkdir(parents=True, exist_ok=True)
                block = ["---"]
                block.append(f"date: {_now_iso()}")
                block.append(f"scene: {sid}")
                block.append(f"type: {entry_type}")
                if tid: block.append(f"id: {tid}")
                if text:
                    block.append("text: |")
                    for line in text.splitlines():
                        block.append(f"  {line}")
                block.append(f"was_good: {str(was_good).lower()}")
                if comment:
                    block.append("comment: |")
                    for line in comment.splitlines():
                        block.append(f"  {line}")
                block.append("")
                with draft_file.open("a", encoding="utf-8") as f:
                    f.write("\n".join(block) + "\n")
                self._send_json(200, {"logged": True})
                return

            if sub == "meta":
                # Merge-update meta.json
                payload = self._read_json()
                if payload is None: return
                meta = _scene_meta(sid) or {}
                for key in ("name", "category", "level1_questions", "quests", "boxes", "trace_style", "sounds", "sounds_enabled"):
                    if key in payload:
                        meta[key] = payload[key]
                meta["updated_at"] = _now_iso()
                meta["box_count"] = len(meta.get("boxes", []))
                _write_json(base / "meta.json", meta)
                # Mirror boxes.json so the player can read it directly.
                if "boxes" in payload:
                    _write_json(base / "boxes.json", meta["boxes"])
                _annotate_quest_images(sid, meta)
                self._send_json(200, {"updated": True, "meta": meta})
                return

            if sub == "resnap":
                meta = _resnap_scene(sid)
                if not meta:
                    self._send_json(500, {"error": "resnap failed"})
                    return
                self._send_json(200, {"updated": True, "meta": meta})
                return

            if sub.startswith("quest/") and sub.endswith("/generate"):
                qid = sub[len("quest/"): -len("/generate")]
                with _lock:
                    if _running:
                        self._send_json(409, {"error": "generation already in progress"})
                        return
                    _running = True
                threading.Thread(target=_kickoff_quest_gen, args=(sid, qid), daemon=True).start()
                self._send_json(202, {"started": True})
                return

        self.send_error(404)

    def log_message(self, fmt: str, *args) -> None:
        if args and isinstance(args[1], str) and args[1].startswith("2"):
            return
        super().log_message(fmt, *args)


def _lan_ips() -> list[str]:
    import socket
    ips: list[str] = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in ips:
            ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith("127.")]


def main() -> int:
    port = int(os.environ.get("PORT", "8000"))
    bind = os.environ.get("BIND", "0.0.0.0")
    print(f"serving public/ on http://{bind}:{port}", flush=True)
    print("  - http://localhost:" + str(port), flush=True)
    for ip in _lan_ips():
        print(f"  - http://{ip}:{port}   (accessible from other devices on your LAN)", flush=True)
    print("Note: Windows firewall may prompt the first time — allow Python on private networks.", flush=True)
    with ThreadingHTTPServer((bind, port), Handler) as httpd:
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
