"""Pipeline de génération assistée :
  - generate_n1_questions(scene_id, count) → ajoute N questions QCM à la scène
  - generate_n2_quests(scene_id, count, per_box=True) → ajoute N quêtes
  - refine_prompt(level) → re-prompt GPT avec corrections pour produire un
    nouveau prompt système

Tous les appels passent par `_chat_client.chat_json` (Azure gpt-5.4-ACCROCHE).
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _chat_client import chat_json, chat_text, image_message_content  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SCENES = ROOT / "public" / "scenes"

PROMPT_FILE = {1: DATA / "prompt_n1.txt", 2: DATA / "prompt_n2.txt"}
ARCHIVE_DIR = {1: DATA / "prompt_n1.archive", 2: DATA / "prompt_n2.archive"}
CORRECTIONS_FILE = {1: DATA / "corrections_n1.txt", 2: DATA / "corrections_n2.txt"}


# ----------------- Fichiers : prompts + corrections -----------------

def read_prompt(level: int) -> str:
    p = PROMPT_FILE[level]
    if not p.exists():
        raise RuntimeError(f"Prompt manquant : {p}")
    return p.read_text(encoding="utf-8")


def write_prompt(level: int, content: str) -> Path:
    """Sauve un nouveau prompt + archive l'ancien avec timestamp."""
    p = PROMPT_FILE[level]
    if p.exists():
        ARCHIVE_DIR[level].mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y%m%dT%H%M%S")
        archived = ARCHIVE_DIR[level] / f"{ts}.txt"
        archived.write_text(p.read_text(encoding="utf-8"), encoding="utf-8")
    p.write_text(content, encoding="utf-8")
    return p


def read_corrections(level: int) -> str:
    """Renvoie le contenu brut du fichier de corrections (markdown)."""
    p = CORRECTIONS_FILE[level]
    return p.read_text(encoding="utf-8") if p.exists() else ""


def append_correction(level: int, entry: dict) -> None:
    """Append une entrée de correction au fichier markdown.

    `entry` : dict avec date, scene, kind, rating, et autres champs libres.
    Format de sortie : markdown lisible humain ET parseable GPT.
    """
    p = CORRECTIONS_FILE[level]
    p.parent.mkdir(parents=True, exist_ok=True)
    block = ["---"]
    for k, v in entry.items():
        if v is None or v == "":
            continue
        sv = str(v).strip()
        if "\n" in sv:
            block.append(f"{k}: |")
            for line in sv.splitlines():
                block.append(f"  {line}")
        else:
            block.append(f"{k}: {sv}")
    block.append("")
    with p.open("a", encoding="utf-8") as f:
        f.write("\n".join(block) + "\n")


# ----------------- Contexte de scène pour GPT -----------------

def _scene_context(scene_id: str) -> dict:
    """Récupère les infos de la scène à transmettre à GPT (nom, catégorie,
    description des cadres, questions/quêtes déjà validées)."""
    meta_path = SCENES / scene_id / "meta.json"
    if not meta_path.exists():
        raise RuntimeError(f"Scène introuvable : {scene_id}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    boxes = meta.get("boxes", [])
    box_descr = []
    for b in boxes:
        subj = (b.get("subject") or "").strip()
        if not subj:
            subj = "(sujet non décrit)"
        box_descr.append(f"  - id={b.get('id')} : {subj}")
    return {
        "name": meta.get("name", scene_id),
        "category": meta.get("category", ""),
        "boxes_text": "\n".join(box_descr) if box_descr else "  (aucun cadre)",
        "n_boxes": len(boxes),
        "level1_existing": meta.get("level1_questions", []),
        "quests_existing": meta.get("quests", []),
    }


def _good_examples(meta_items: list[dict], level: int, limit: int = 6) -> str:
    """Renvoie un markdown des items déjà notés `good` ou `nuanced` (validés)
    pour les injecter dans le prompt comme exemples positifs."""
    good = [
        x for x in meta_items
        if x.get("_rating") in ("good", "nuanced")
    ][:limit]
    if not good:
        return "  (aucun exemple validé encore)"
    out = []
    for it in good:
        if level == 1:
            txt = it.get("text", "")
            choices = it.get("choices", [])
            correct = it.get("correct_index", 0)
            out.append(f"  - QUESTION: {txt}")
            for i, c in enumerate(choices):
                mark = "✓" if i == correct else " "
                out.append(f"      [{mark}] {c}")
            if it.get("_note"):
                out.append(f"      note d'amélioration : {it['_note']}")
        else:
            out.append(f"  - QUÊTE: {it.get('title','?')} — {it.get('intro_text','')}")
            for c in it.get("dialogue_choices", []):
                mark = "★" if c.get("is_best") else " "
                out.append(f"      [{mark}] {c.get('text','')}")
            if it.get("_note"):
                out.append(f"      note d'amélioration : {it['_note']}")
    return "\n".join(out)


def _bad_examples_notes(level: int, limit: int = 30) -> str:
    """Extrait du fichier corrections les raisons des refus, pour informer
    GPT de ce qu'il ne faut PAS faire. On garde les `limit` dernières."""
    raw = read_corrections(level)
    if not raw.strip():
        return "  (aucune correction enregistrée — c'est ta première génération)"
    # Parse blocks separated by `---`
    blocks = [b.strip() for b in raw.split("---") if b.strip()]
    bad = []
    for b in blocks[-limit*3:]:  # over-fetch puis filtre
        if "rating: refused" in b or "rating: nuanced" in b:
            bad.append(b)
    bad = bad[-limit:]
    if not bad:
        return "  (aucun refus / nuance enregistré)"
    return "\n\n".join(f"  ---\n{b}" for b in bad)


# ----------------- Génération principale -----------------

def _fill_prompt(template: str, values: dict) -> str:
    """Remplace les `{key}` par leur valeur via str.replace — évite les
    soucis de `.format()` quand le template contient des `{...}` JSON."""
    out = template
    for k, v in values.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def generate_n1_questions(scene_id: str, count: int = 4) -> list[dict]:
    """Génère N questions QCM pour la scène. Renvoie la liste à ajouter
    à `meta.level1_questions`. N'écrit PAS le meta — l'appelant le fait."""
    ctx = _scene_context(scene_id)
    prompt_template = read_prompt(1)
    prompt_filled = _fill_prompt(prompt_template, {
        "scene_context": (
            f"Module : {ctx['name']}\n"
            f"Catégorie : {ctx['category']}\n"
            f"Personnages présents ({ctx['n_boxes']}) :\n{ctx['boxes_text']}\n"
            f"Objectif : génère {count} question(s) QCM d'observation."
        ),
        "good_examples": _good_examples(ctx["level1_existing"], level=1),
        "bad_examples_notes": _bad_examples_notes(level=1),
    })
    j = chat_json(
        messages=[
            {"role": "system", "content": prompt_filled},
            {"role": "user", "content": f"Génère {count} questions différentes des exemples validés."},
        ],
        max_completion_tokens=4000,
        timeout=180,
    )
    questions = j.get("questions", [])
    out = []
    now_ms = int(time.time() * 1000)
    for i, q in enumerate(questions[:count]):
        out.append({
            "id": f"q_gen_{now_ms}_{i}",
            "text": q.get("text", "").strip(),
            "choices": [str(c).strip() for c in (q.get("choices") or [])][:4],
            "correct_index": int(q.get("correct_index", 0)),
            "explanation": q.get("explanation", "").strip(),
            "_origin": "gpt",
            "_rating": None,
            "_note": None,
        })
    return out


def generate_n2_quests(scene_id: str, count: int = 1,
                       per_box: bool = True) -> list[dict]:
    """Génère N quêtes pour la scène.

    Si `per_box=True`, on génère 1 quête PAR CADRE existant (count est ignoré
    et remplacé par n_boxes). Sinon on génère `count` quêtes sur n'importe
    quel cadre disponible.
    """
    ctx = _scene_context(scene_id)
    if per_box:
        count = max(1, ctx["n_boxes"])
    prompt_template = read_prompt(2)
    prompt_filled = _fill_prompt(prompt_template, {
        "scene_context": (
            f"Module : {ctx['name']}\n"
            f"Catégorie : {ctx['category']}\n"
            f"Personnages disponibles (utilise leur id comme box_id) :\n{ctx['boxes_text']}\n"
            f"Objectif : génère {count} quête(s) d'approche commerciale"
            f" {'(une par cadre, en variant les angles d''approche)' if per_box else ''}."
        ),
        "good_examples": _good_examples(ctx["quests_existing"], level=2),
        "bad_examples_notes": _bad_examples_notes(level=2),
    })
    j = chat_json(
        messages=[
            {"role": "system", "content": prompt_filled},
            {"role": "user", "content":
                f"Génère {count} quête(s) différente(s) des exemples validés."},
        ],
        max_completion_tokens=6000,
        timeout=180,
    )
    quests = j.get("quests", [])
    out = []
    now_ms = int(time.time() * 1000)
    for i, q in enumerate(quests[:count]):
        choices = q.get("dialogue_choices") or []
        # Sécurise is_best : exactement une réponse marquée
        any_best = any(c.get("is_best") for c in choices)
        if not any_best and choices:
            choices[0]["is_best"] = True
        out.append({
            "id": f"quest_gen_{now_ms}_{i}",
            "box_id": str(q.get("box_id", "")),
            "title": q.get("title", "").strip(),
            "intro_text": q.get("intro_text", "").strip(),
            "dialogue_choices": [
                {
                    "text": (c.get("text") or "").strip(),
                    "is_best": bool(c.get("is_best")),
                    "explanation": (c.get("explanation") or "").strip(),
                }
                for c in choices
            ],
            "_origin": "gpt",
            "_rating": None,
            "_note": None,
        })
    return out


# ----------------- Description d'un cadre via vision -----------------

def describe_box(scene_id: str, box_id: str) -> str:
    """Demande à GPT-5.4 (vision) de décrire en 2-3 phrases le personnage
    et son contexte visible dans le cadre. Stocké dans meta.boxes[i]._description
    pour ne pas refaire la vision à chaque génération de quête. Si la
    description existe déjà, on la retourne directement.

    Cherche l'image dans cet ordre :
      1. scenes/<sid>/exp3/imageB/box-<id>.jpg (perso + bokeh, idéal)
      2. scenes/<sid>/crops/box-<id>-input.png (crop master brut)
    """
    base = SCENES / scene_id
    meta_path = base / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    boxes = meta.get("boxes", [])
    target = next((b for b in boxes if str(b.get("id")) == str(box_id)), None)
    if not target:
        raise RuntimeError(f"Cadre {box_id} introuvable dans la scène {scene_id}")
    # Cache hit ?
    if target.get("_description"):
        return target["_description"]
    # Trouve l'image
    img_candidates = [
        base / "exp3" / "imageB" / f"box-{box_id}.jpg",
        base / "crops" / f"box-{box_id}-input.png",
    ]
    img_path = next((p for p in img_candidates if p.exists()), None)
    if not img_path:
        # Pas d'image dispo : on retombe sur le sujet textuel
        return target.get("subject", "").strip() or "(aucune image ni description)"
    content = image_message_content(
        text=(
            "Décris en 2-3 phrases courtes le personnage visible dans cette image "
            "(âge approximatif, vêtements, posture, regard, action en cours, ambiance). "
            "Reste factuel et précis — pas d'interprétation psychologique poussée. "
            "Réponds en français, en une seule phrase fluide."
        ),
        image_path=str(img_path),
        detail="low",
    )
    descr = chat_text(
        messages=[
            {"role": "system", "content":
                "Tu es expert en observation comportementale en boutique de luxe. "
                "Tu décris des personnages que tu vois dans une image."},
            {"role": "user", "content": content},
        ],
        max_completion_tokens=200,
        timeout=60,
    ).strip()
    # Cache la description dans meta
    target["_description"] = descr
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return descr


# ----------------- Génération d'UNE quête liée à un cadre ---------------

def generate_one_quest_for_box(scene_id: str, box_id: str) -> dict:
    """Génère UNE seule quête liée à un cadre spécifique. Pipeline :
      1. Récupère / génère la description du cadre (vision).
      2. Appelle GPT avec le prompt N2 + contexte cadre + IMAGE en vision.
      3. Renvoie le payload { title, intro_text, dialogue_choices, _origin:gpt }.

    Le quest n'est PAS persisté ici — l'appelant le fait (l'éditeur attend
    le retour pour pré-remplir le quest-modal et laisser l'utilisateur
    noter/éditer avant de sauver).
    """
    base = SCENES / scene_id
    meta = json.loads((base / "meta.json").read_text(encoding="utf-8"))
    target_box = next((b for b in meta.get("boxes", [])
                       if str(b.get("id")) == str(box_id)), None)
    if not target_box:
        raise RuntimeError(f"Cadre {box_id} introuvable")

    # Description (génère via vision si pas encore en cache)
    box_descr = describe_box(scene_id, box_id)

    # Trouve l'image à passer à GPT (vision) pour la génération
    img_candidates = [
        base / "exp3" / "imageB" / f"box-{box_id}.jpg",
        base / "crops" / f"box-{box_id}-input.png",
    ]
    img_path = next((p for p in img_candidates if p.exists()), None)

    # Contexte injecté dans le prompt template
    ctx = _scene_context(scene_id)
    prompt_template = read_prompt(2)
    prompt_filled = _fill_prompt(prompt_template, {
        "scene_context": (
            f"Module : {ctx['name']}\n"
            f"Catégorie : {ctx['category']}\n\n"
            f"CADRE CIBLE — box_id={box_id}\n"
            f"Sujet annoté (texte) : {target_box.get('subject','(aucun)')}\n"
            f"Description visuelle : {box_descr}\n\n"
            f"Génère UNE quête pour CE personnage spécifiquement, en t'appuyant sur "
            f"l'image fournie et la description ci-dessus. Le `box_id` à utiliser "
            f"dans le JSON est exactement : {box_id}"
        ),
        "good_examples": _good_examples(ctx["quests_existing"], level=2),
        "bad_examples_notes": _bad_examples_notes(level=2),
    })

    user_content = image_message_content(
        text=(
            f"Génère UNE quête pour le cadre {box_id} (image fournie). "
            "Respecte strictement le format JSON spécifié dans le system prompt — "
            "tu peux renvoyer un objet contenant `quests: [<une seule quête>]`."
        ),
        image_path=str(img_path) if img_path else None,
        detail="high",
    )
    j = chat_json(
        messages=[
            {"role": "system", "content": prompt_filled},
            {"role": "user", "content": user_content},
        ],
        max_completion_tokens=4000,
        timeout=180,
    )
    quests = j.get("quests", [])
    if not quests:
        raise RuntimeError("GPT n'a pas renvoyé de quête")
    q = quests[0]
    choices = q.get("dialogue_choices") or []
    any_best = any(c.get("is_best") for c in choices)
    if not any_best and choices:
        choices[0]["is_best"] = True
    return {
        "box_id": str(box_id),
        "title": (q.get("title") or "").strip(),
        "intro_text": (q.get("intro_text") or "").strip(),
        "dialogue_choices": [
            {
                "text": (c.get("text") or "").strip(),
                "is_best": bool(c.get("is_best")),
                "explanation": (c.get("explanation") or "").strip(),
            } for c in choices
        ],
        "_origin": "gpt",
        "_box_description": box_descr,  # utile pour les corrections plus tard
    }


# ----------------- Régénération d'un distracteur unique -----------------

def regen_distractor(level: int, question_or_quest: dict,
                     refused_choice_text: str, reason: str) -> dict:
    """Demande à GPT de proposer UN nouveau distracteur en remplacement
    d'un mauvais distracteur refusé.

    `question_or_quest` : le dict de la question/quête concernée.
    `refused_choice_text` : le texte du distracteur refusé.
    `reason` : la raison écrite par l'utilisateur.

    Renvoie un dict {text, explanation, [is_best:false]} prêt à insérer.
    """
    if level == 1:
        existing = "\n".join(
            f"  - {c}" + (" (correct)" if i == question_or_quest.get("correct_index", 0) else "")
            for i, c in enumerate(question_or_quest.get("choices", []))
            if c != refused_choice_text
        )
        sys_msg = (
            "Tu es expert en QCM d'observation pour vente luxe. Produis UN seul "
            "distracteur plausible (réponse fausse mais crédible) pour remplacer "
            "celui qui a été refusé. Le distracteur doit faire douter sans être absurde."
        )
        user_msg = (
            f"QUESTION : {question_or_quest.get('text','')}\n"
            f"CHOIX RESTANTS :\n{existing}\n"
            f"DISTRACTEUR REFUSÉ : {refused_choice_text}\n"
            f"RAISON DU REFUS : {reason}\n\n"
            "Réponds en JSON : {\"text\": \"...\", \"explanation\": \"...\"}"
        )
    else:
        existing = "\n".join(
            f"  - {c.get('text','')}" + (" (meilleur choix)" if c.get("is_best") else "")
            for c in question_or_quest.get("dialogue_choices", [])
            if c.get("text") != refused_choice_text
        )
        sys_msg = (
            "Tu es expert en formation vente luxe. Produis UN seul choix de "
            "dialogue plausible mais sous-optimal (pas le meilleur choix) pour "
            "remplacer celui refusé. Doit faire douter sans être absurde."
        )
        user_msg = (
            f"QUÊTE : {question_or_quest.get('title','')}\n"
            f"CONTEXTE : {question_or_quest.get('intro_text','')}\n"
            f"CHOIX RESTANTS :\n{existing}\n"
            f"CHOIX REFUSÉ : {refused_choice_text}\n"
            f"RAISON DU REFUS : {reason}\n\n"
            "Réponds en JSON : {\"text\": \"...\", \"explanation\": \"...\"}"
        )
    j = chat_json(
        messages=[
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": user_msg},
        ],
        max_completion_tokens=500,
        timeout=60,
    )
    return {
        "text": j.get("text", "").strip(),
        "explanation": j.get("explanation", "").strip(),
        "is_best": False,  # toujours un distracteur (pas le meilleur)
    }


# ----------------- Refinement du prompt -----------------

REFINE_INSTR = """\
Tu es expert en prompt engineering. Tu vas améliorer un prompt système
utilisé pour générer des {kind} de formation vente luxe.

Voici le prompt actuel :
─── PROMPT ACTUEL ───────────────────────────────
{current_prompt}
─── FIN ─────────────────────────────────────────

Voici l'historique des corrections accumulées par l'utilisateur sur les
générations précédentes (chaque entrée note un item validé/refusé avec
une raison) :

─── CORRECTIONS ────────────────────────────────
{corrections}
─── FIN ─────────────────────────────────────────

Ta tâche :
1. Identifie les PATTERNS qui reviennent dans les refus / nuances
   (ex. « questions trop évidentes », « distracteurs trop absurdes »,
   « ton trop commercial », etc.).
2. Produis une NOUVELLE VERSION du prompt qui intègre ces apprentissages.
3. Conserve la structure générale (sections PRINCIPES, format JSON, etc.)
   mais affine les règles concrètes en y injectant les patterns identifiés.
4. Le prompt nouveau version doit rester sous 3000 tokens.

Réponds UNIQUEMENT avec le nouveau prompt — pas de méta-commentaire,
pas de "Voici le prompt :", pas de balise markdown. Juste le contenu.
"""


def refine_prompt(level: int) -> dict:
    """Re-prompt GPT avec corrections + prompt actuel → nouveau prompt.
    Sauve le nouveau prompt et archive l'ancien. Renvoie un résumé.
    """
    current = read_prompt(level)
    corrections = read_corrections(level)
    if not corrections.strip():
        raise RuntimeError(
            f"Aucune correction encore enregistrée pour le niveau {level}. "
            f"Note d'abord quelques générations avant d'affiner."
        )
    kind = "questions QCM d'observation" if level == 1 else "quêtes de dialogue commercial"
    instr = _fill_prompt(REFINE_INSTR, {
        "kind": kind, "current_prompt": current, "corrections": corrections,
    })
    new_prompt = chat_text(
        messages=[
            {"role": "system", "content": "Tu es expert en prompt engineering."},
            {"role": "user", "content": instr},
        ],
        max_completion_tokens=6000,
        timeout=180,
    )
    new_prompt = new_prompt.strip()
    # Sécurité : si la réponse est vide ou bizarrement courte, on refuse.
    if len(new_prompt) < 200:
        raise RuntimeError(
            f"Refine renvoie un prompt suspect ({len(new_prompt)} chars), aborted."
        )
    archived_to = write_prompt(level, new_prompt)
    # Compte les corrections traitées
    n_corr = len([b for b in corrections.split("---") if b.strip()])
    return {
        "ok": True,
        "level": level,
        "new_prompt_path": str(archived_to),
        "new_prompt_chars": len(new_prompt),
        "corrections_used": n_corr,
    }
