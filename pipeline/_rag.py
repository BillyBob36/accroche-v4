"""RAG sémantique pour la génération assistée Accroche.

Architecture :
  - À chaque sauvegarde de correction, on calcule un embedding du texte
    (via text-embedding-3-small sur johannfoundry) et on l'ajoute à
    l'entrée JSONL. Une entrée = une ligne JSON contenant rating + note
    + contexte (box, scene) + embedding.

  - À chaque génération (Niveau 1 ou Niveau 2), on calcule l'embedding
    du CONTEXTE COURANT (par exemple : description du cadre +
    sujet + module + catégorie) puis on cherche les TOP-K (par défaut 8)
    corrections sémantiquement similaires via similarité cosinus.

  - On injecte ces top-K dans le system prompt à la place du dump
    complet du fichier corrections. → Le prompt reste léger même
    quand le corpus grossit (10k+ corrections sans souci).

Storage :
  - Source de vérité : data/corrections_n{1,2}.jsonl (1 entrée par ligne)
  - Mirror lisible humain : data/corrections_n{1,2}.txt (markdown
    actuel, conservé pour les yeux + le refine prompt)

Hybride avec le refine existant :
  - Refine = compaction périodique des patterns récurrents dans le
    prompt système (rule-level, dans le system prompt).
  - RAG = injection contextuelle dynamique des cas spécifiques au
    contexte courant (instance-level, au moment de la génération).
  - Les deux travaillent ensemble : le prompt système contient les
    règles générales extraites, le RAG ajoute les exemples ciblés.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def _env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if not v:
        raise RuntimeError(f"Variable d'environnement manquante : {name}")
    return v


def embed_text(text: str, timeout: int = 30) -> list[float] | None:
    """Calcule l'embedding d'un texte via text-embedding-3-small sur Azure.
    Renvoie None si le service est indisponible / mal configuré (ne fait
    pas planter le pipeline appelant — RAG est best-effort)."""
    text = (text or "").strip()
    if not text:
        return None
    try:
        endpoint = _env("AZURE_OPENAI_EMBED_ENDPOINT").rstrip("/")
        deploy = _env("AZURE_OPENAI_EMBED_DEPLOYMENT")
        api_version = os.environ.get("AZURE_OPENAI_EMBED_API_VERSION", "2025-01-01-preview")
        key = _env("AZURE_OPENAI_EMBED_API_KEY")
    except RuntimeError as e:
        print(f"[rag] embed disabled: {e}", file=sys.stderr)
        return None
    url = f"{endpoint}/openai/deployments/{deploy}/embeddings?api-version={api_version}"
    body = {"input": text[:8000]}  # 8k chars de safety
    try:
        req = urllib.request.Request(
            url, method="POST", data=json.dumps(body).encode("utf-8"),
            headers={"api-key": key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            j = json.loads(resp.read().decode("utf-8"))
        return j["data"][0]["embedding"]
    except Exception as e:
        print(f"[rag] embed failed: {e}", file=sys.stderr)
        return None


def cosine(a: list[float], b: list[float]) -> float:
    """Similarité cosinus entre 2 vecteurs. Renvoie 0.0 si dimensions
    incompatibles ou vecteur nul."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0; na = 0.0; nb = 0.0
    for x, y in zip(a, b):
        dot += x * y; na += x * x; nb += y * y
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / ((na ** 0.5) * (nb ** 0.5))


def _jsonl_path(level: int) -> Path:
    return DATA / f"corrections_n{level}.jsonl"


def load_corrections(level: int) -> list[dict]:
    """Charge toutes les corrections JSONL d'un niveau. Renvoie [] si
    fichier inexistant ou vide."""
    p = _jsonl_path(level)
    if not p.exists():
        return []
    out: list[dict] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def append_correction_jsonl(level: int, entry: dict) -> None:
    """Append une entrée correction au JSONL en calculant son embedding
    si absent. Crée le fichier si nécessaire.

    L'embedding est calculé sur la concaténation du contexte le plus
    informatif (box_subject + box_description + content + note + rating
    + rating_label), pour que la recherche sémantique trouve les
    corrections pertinentes face à un nouveau cas similaire.
    """
    p = _jsonl_path(level)
    p.parent.mkdir(parents=True, exist_ok=True)
    if "embedding" not in entry:
        embed_input = _build_embed_input(entry)
        emb = embed_text(embed_input)
        if emb is not None:
            entry["embedding"] = emb
            entry["_embed_input"] = embed_input  # debug visibility
    with p.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _build_embed_input(entry: dict) -> str:
    """Combine les champs sémantiquement utiles d'une entrée correction en
    une chaîne unique servant d'input à l'embedding.

    Inclut les facettes client (niveau social, DISC, code luxe) pour que
    les matches RAG soient calibrés sur la TYPOLOGIE de client autant que
    sur le contenu textuel."""
    parts = []
    # Facettes structurées (les plus discriminantes pour le matching client)
    for k in ("niveau_social", "disc_profile", "code_luxe"):
        v = entry.get(k)
        if v: parts.append(f"{k}: {v}")
    # Description du cadre (vision factuelle)
    for k in ("box_subject", "box_description"):
        v = entry.get(k)
        if v: parts.append(str(v))
    # Contenu du champ noté
    for k in ("question", "quest_title", "intro_text", "content", "answer", "explanation"):
        v = entry.get(k)
        if v: parts.append(str(v))
    rating = entry.get("rating")
    rating_label = entry.get("rating_label")
    if rating_label:
        parts.append(rating_label)
    elif rating:
        parts.append(f"rating={rating}")
    note = entry.get("note")
    if note:
        parts.append(str(note))
    return " | ".join(parts)[:6000]


def find_top_k(query_embedding: list[float] | None, corrections: list[dict],
               k: int = 8, min_score: float = 0.30) -> list[dict]:
    """Renvoie les TOP-K corrections les plus similaires au query_embedding,
    filtrées par seuil min_score (similarité cosinus). Si query_embedding
    est None (embedding désactivé), renvoie les K plus récentes en
    fallback."""
    if not corrections:
        return []
    if query_embedding is None:
        # Fallback : pas d'embedding → on prend les K plus récentes
        return corrections[-k:]
    scored = []
    for c in corrections:
        emb = c.get("embedding")
        if not emb:
            continue
        s = cosine(query_embedding, emb)
        if s >= min_score:
            scored.append((s, c))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [c for _, c in scored[:k]]


def format_corrections_for_prompt(corrections: list[dict], header: str = "") -> str:
    """Format les corrections en bloc texte injectable dans un system prompt.
    Distingue les bonnes pratiques (rating=good) des anti-patterns
    (rating=refused / nuanced) pour aider GPT à comprendre la polarité."""
    if not corrections:
        return ""
    good_lines: list[str] = []
    bad_lines: list[str] = []
    for c in corrections:
        rating = c.get("rating", "")
        kind = c.get("kind", "")
        content = c.get("content") or c.get("answer") or c.get("question") or c.get("quest_title") or ""
        label = c.get("rating_label") or ""
        note = c.get("note") or ""
        # Préférence : description vision (riche, factuelle, observable)
        # plutôt que box_subject (étiquette courte de l'auteur). Si la
        # vision n'a pas tourné, fallback sur box_subject.
        box_descr = c.get("box_description", "")
        box_subj = c.get("box_subject", "")
        box_lbl = box_descr or box_subj or ""
        # Facettes structurées éventuellement disponibles (analyse cadre)
        niveau_social = c.get("niveau_social", "")
        disc_profile = c.get("disc_profile", "")
        code_luxe = c.get("code_luxe", "")
        facets = []
        if niveau_social: facets.append(f"social: {niveau_social}")
        if disc_profile: facets.append(f"DISC: {disc_profile}")
        if code_luxe: facets.append(f"code-luxe: {code_luxe}")
        line_parts = []
        if facets: line_parts.append(f"[{' · '.join(facets)}]")
        if box_lbl: line_parts.append(f"[cadre: {box_lbl[:240]}]")
        if kind: line_parts.append(f"[{kind}]")
        if content: line_parts.append(f'"{content[:200]}"')
        if label: line_parts.append(f"→ {label}")
        if note: line_parts.append(f"raison: {note[:300]}")
        line = "  - " + " ".join(line_parts)
        if rating == "good":
            good_lines.append(line)
        elif rating in ("nuanced", "refused"):
            bad_lines.append(line)
    blocks = []
    if header:
        blocks.append(header)
    if good_lines:
        blocks.append("BONNES PRATIQUES (à reproduire le style) :")
        blocks.extend(good_lines)
    if bad_lines:
        blocks.append("\nANTI-PATTERNS (à éviter) :")
        blocks.extend(bad_lines)
    return "\n".join(blocks)
