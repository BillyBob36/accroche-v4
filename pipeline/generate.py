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
from _rag import (  # noqa: E402
    embed_text, load_corrections, append_correction_jsonl,
    find_top_k, format_corrections_for_prompt,
)

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
    """Append une entrée de correction aux deux stockages :

    1. JSONL (source de vérité) : `data/corrections_n{level}.jsonl` —
       1 entrée par ligne, embedding calculé à la volée et inclus, prêt
       pour le RAG top-K à la prochaine génération.
    2. Markdown (lisibilité humain + lecture par le `refine_prompt`) :
       même contenu présenté en bloc YAML-front-matter.

    `entry` doit contenir au minimum : date, scene, level, kind, rating.
    Les autres champs (content, note, box_*, rating_label, etc.) sont
    libres et passés tels quels.
    """
    # 1. JSONL avec embedding (source canonique pour le RAG)
    try:
        append_correction_jsonl(level, dict(entry))  # copy pour ne pas polluer
    except Exception as e:
        print(f"[append_correction] JSONL write failed: {e}", file=sys.stderr)

    # 2. Markdown lisible (pour humain + refine_prompt qui parse l'historique)
    p = CORRECTIONS_FILE[level]
    p.parent.mkdir(parents=True, exist_ok=True)
    block = ["---"]
    for k, v in entry.items():
        if v is None or v == "":
            continue
        # Ne pas dumper l'embedding (1536 floats) dans le markdown lisible
        if k in ("embedding", "_embed_input"):
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


def _rag_block_for(query_text: str, level: int, k: int = 8) -> str:
    """Construit le bloc RAG à injecter dans le system prompt : top-K
    corrections sémantiquement similaires au `query_text`. Sans appel
    réseau si le service d'embedding n'est pas configuré (fallback :
    K plus récentes)."""
    corrections = load_corrections(level)
    if not corrections:
        return "  (corpus de corrections encore vide — premier jet)"
    qemb = embed_text(query_text)
    top = find_top_k(qemb, corrections, k=k)
    formatted = format_corrections_for_prompt(top)
    return formatted or "  (aucune correction sémantiquement proche)"


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
    # Query RAG : on cherche les corrections passées les plus proches du
    # contexte de la scène (catégorie + liste des cadres présents).
    rag_query = (
        f"{ctx['name']} {ctx['category']} questions observation "
        f"{ctx['boxes_text']}"
    )
    rag_block = _rag_block_for(rag_query, level=1, k=8)
    prompt_filled = _fill_prompt(prompt_template, {
        "scene_context": (
            f"Module : {ctx['name']}\n"
            f"Catégorie : {ctx['category']}\n"
            f"Personnages présents ({ctx['n_boxes']}) :\n{ctx['boxes_text']}\n"
            f"Objectif : génère {count} question(s) QCM d'observation."
        ),
        "good_examples": rag_block,
        "bad_examples_notes": rag_block,  # un seul bloc unifié good+bad via RAG
    })
    j = chat_json(
        messages=[
            {"role": "system", "content": prompt_filled},
            {"role": "user", "content": f"Génère {count} questions différentes des corrections fournies."},
        ],
        max_completion_tokens=4000,
        temperature=0.4,
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
    rag_query = f"{ctx['name']} {ctx['category']} quête approche {ctx['boxes_text']}"
    rag_block = _rag_block_for(rag_query, level=2, k=8)
    prompt_filled = _fill_prompt(prompt_template, {
        "scene_context": (
            f"Module : {ctx['name']}\n"
            f"Catégorie : {ctx['category']}\n"
            f"Personnages disponibles (utilise leur id comme box_id) :\n{ctx['boxes_text']}\n"
            f"Objectif : génère {count} quête(s) d'approche commerciale"
            f" {'(une par cadre, en variant les angles d''approche)' if per_box else ''}."
        ),
        "good_examples": rag_block,
        "bad_examples_notes": rag_block,
    })
    j = chat_json(
        messages=[
            {"role": "system", "content": prompt_filled},
            {"role": "user", "content":
                f"Génère {count} quête(s) différente(s) des corrections fournies."},
        ],
        max_completion_tokens=6000,
        temperature=0.4,
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

def describe_box(scene_id: str, box_id: str, force: bool = False) -> str:
    """Demande à GPT-5.4 (vision) de décrire DE FAÇON FACTUELLE et
    DÉTAILLÉE le personnage visible dans le cadre. La description est
    stockée dans meta.boxes[i]._description (cache).

    Si force=True, la description est recalculée même si en cache (utile
    après une régénération d'image B/C ou après un upgrade du prompt).

    Image source par ordre de préférence :
      1. scenes/<sid>/exp3/imageB/box-<id>.jpg (perso + bokeh, l'idéal)
      2. scenes/<sid>/crops/box-<id>-input.png (crop master brut)

    Le prompt impose à GPT de :
      - Ne rien inventer (« si tu ne vois pas, ne dis rien »)
      - Décrire SEULEMENT ce qui est visible (vêtements, accessoires,
        posture, regard, geste, environnement immédiat)
      - Pas d'interprétation psychologique (« semble intéressé », « a
        l'air pressé ») — uniquement les SIGNAUX visibles
      - Reste sous 4 phrases / 80 mots pour éviter les inflations
    """
    base = SCENES / scene_id
    meta_path = base / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    boxes = meta.get("boxes", [])
    target = next((b for b in boxes if str(b.get("id")) == str(box_id)), None)
    if not target:
        raise RuntimeError(f"Cadre {box_id} introuvable dans la scène {scene_id}")
    # Cache hit ?
    if target.get("_description") and not force:
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

    sys_msg = (
        "Tu es OBSERVATEUR FACTUEL d'une scène de boutique de luxe. Tu produis "
        "une analyse SIMPLE et DENSE du ou des personnages visibles dans l'image. "
        "Cette analyse sera réutilisée par un coach marketing qui écrira un quizz "
        "de formation vente — tu lui sers l'OBSERVATION, pas la prescription.\n\n"
        "RÈGLES STRICTES :\n"
        "  • NE DÉCRIS JAMAIS le décor, le fond, les vitrines, le mobilier — "
        "uniquement les personnages.\n"
        "  • Une analyse PAR personnage dans le tableau `personnages`.\n"
        "  • S'IL Y A PLUSIEURS PERSONNES (couple, amis, famille, collègues), "
        "ajoute aussi un objet `dynamique_groupe` qui décrit l'interaction "
        "entre elles — c'est SOUVENT le signal le plus important pour la vente.\n"
        "  • AUCUNE prescription, AUCUNE recommandation d'action, AUCUNE accroche, "
        "AUCUN conseil au vendeur. Tu DÉCRIS ce que tu vois, point. Le coach "
        "marketing en aval décidera quoi faire à partir de la mémoire RAG.\n"
        "  • Vocabulaire factuel et concret. Interdit : « élégant », « semble », "
        "« paraît », « a l'air ». Autorisé : « manteau navy », « regarde vers la "
        "vitrine droite », « tient son sac à deux mains ».\n"
        "  • Si un signal n'est pas lisible, ne le mentionne pas plutôt que "
        "d'inventer."
    )
    user_text = (
        "Renvoie un JSON STRICT avec cette structure :\n"
        "{\n"
        '  "personnages": [\n'
        "    {\n"
        '      "qui": "1 phrase. Genre + tranche d\'âge + accompagnement + style visuel + lecture sociale courte. '
        'Ex: \\"Femme 35-45, solo, soignée, code discrétion luxe\\" ; \\"Homme ~40 ans pensif, costume sobre, mains croisées\\" ; \\"Dame senior 65+, manteau beige, sac modeste\\".",\n'
        '      "situation": "1 phrase. Ce qu\'il/elle FAIT À CET INSTANT : phase (entrée / exploration / focus produit / hésitation / sortie), regard, posture, intention lisible, signaux d\'ouverture/défensive/pression. '
        'Ex: \\"Exploration patiente, regard appuyé sur la vitrine droite, posture ouverte\\" ; \\"Sourcils froncés, mains dans le dos, regard interne sur les bagues\\"."\n'
        "    }\n"
        "  ],\n"
        '  "dynamique_groupe": {\n'
        '    "interaction": "1 phrase. Comment les personnes interagissent en cet instant : qui parle/regarde qui, complicité ou tension, gestes partagés ou non. '
        'Ex: \\"Elle le regarde lui plutôt que les pièces, attend qu\'il prenne la parole\\" ; \\"Les trois amies se passent des commentaires complices en pointant des pièces\\".",\n'
        '    "roles": "1 phrase. Qui joue quel rôle visible : décideur, freineur, prescripteur, accompagnant passif, suiveur. Décris ce que tu OBSERVES, ne prescris pas. '
        'Ex: \\"Lui = visage pensif et mains croisées, en charge mentale de la décision. Elle = sourire et regard porté sur lui, en attente\\".",\n'
        '    "atmosphere": "1 phrase. Climat émotionnel observable : complicité joyeuse, tension feutrée, hésitation partagée, indifférence respectueuse, etc. '
        'Ex: \\"Hésitation calme et bienveillante\\" ; \\"Énergie ludique et complice\\"."\n'
        "  },\n"
        '  "tags": ["...4 à 8 facettes courtes pour le matching sémantique..."],\n'
        '  "resume": "Une phrase ≤ 30 mots qui résume globalement la scène (utilisée comme aperçu humain)."\n'
        "}\n\n"
        "IMPORTANT : si UN SEUL personnage est visible, OMETS complètement le champ "
        "`dynamique_groupe` (ne renvoie pas l\'objet, pas même vide).\n\n"
        "Vocabulaire stable à privilégier pour `tags` (pour que le RAG matche bien des "
        "situations équivalentes) :\n"
        "  • composition  : solo / couple / groupe / famille\n"
        "  • phase        : entree / exploration / focus / hesitant / presse / attente / sortie\n"
        "  • ouverture    : ouvert / defensif / neutre\n"
        "  • code         : discretion / ostentation / neutre\n"
        "  • expertise    : novice / amateur / expert\n"
        "  • intention    : intention-faible / intention-moyenne / intention-forte\n"
        "  • age          : jeune / mature / senior\n"
        "  • mission      : exploration / cadeau / planifie / accompagnement / curiosite\n"
        "  • dynamique    : decideur-clair / decideur-mixte / freineur-visible / complicite / tension\n"
        "Choisis 4-8 tags les plus saillants. Tu peux ajouter d'autres tags pertinents "
        "(`alliance-visible`, `signal-pression`, `groupe-amies`, etc.) si c'est utile."
    )
    sujet_txt = (target.get("subject") or "").strip()
    if sujet_txt:
        user_text += f"\n\nNote contextuelle (sujet annoté par l'auteur) : « {sujet_txt} ». À utiliser comme indice de cadrage, ne pas le recopier."

    content = image_message_content(
        text=user_text, image_path=str(img_path), detail="high",
    )
    analysis = chat_json(
        messages=[
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": content},
        ],
        max_completion_tokens=1200,
        temperature=0.2,
        timeout=120,
    )
    # Fallback en cas de retour malformé. Prend `resume` (nouveau schéma) ou
    # `resume_prose` (ancien schéma) ; si rien, reconstruit depuis qui+situation.
    descr = (analysis.get("resume") or analysis.get("resume_prose") or "").strip()
    if not descr and analysis.get("personnages"):
        parts = []
        for p in analysis.get("personnages", [])[:5]:
            # Nouveau schéma : qui + situation
            seg = " ".join(filter(None, [p.get("qui", ""), p.get("situation", "")]))
            # Ancien schéma : physique + tenue (compat)
            if not seg.strip():
                seg = " ".join(filter(None, [
                    p.get("physique", ""), p.get("tenue", ""),
                    p.get("accessoires", ""), p.get("cheveux_attitude", ""),
                ]))
            if seg.strip():
                parts.append(seg.strip())
        descr = " ".join(parts)
    if not descr:
        descr = "(analyse échouée — re-essayer plus tard)"
    # Cache + structuré
    target["_description"] = descr
    target["_analysis"] = analysis
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return descr


def describe_all_boxes(scene_id: str, force: bool = False) -> dict:
    """Génère / régénère les descriptions de TOUS les cadres d'une scène.
    Utile après un upgrade du prompt de description ou pour amorcer un
    module fraîchement importé. Renvoie { box_id: description }."""
    base = SCENES / scene_id
    meta = json.loads((base / "meta.json").read_text(encoding="utf-8"))
    out = {}
    for b in meta.get("boxes", []):
        bid = str(b.get("id"))
        try:
            out[bid] = describe_box(scene_id, bid, force=force)
        except Exception as e:
            out[bid] = f"(échec: {e})"
    return out


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
    # RAG : query sémantique = description du cadre + facettes structurées
    # (niveau social + DISC + code luxe). Cherche les corrections passées
    # qui parlent de personnages du MÊME TYPE socio-comportemental.
    analysis = target_box.get("_analysis", {})
    first_perso = (analysis.get("personnages") or [{}])[0]
    facets_query = " ".join(filter(None, [
        first_perso.get("niveau_social_estime"),
        first_perso.get("disc_profile_estime"),
        first_perso.get("code_luxe_lu"),
    ]))
    rag_query = (
        f"{facets_query} | {target_box.get('subject','')} | {box_descr} | "
        f"{ctx['category']} {ctx['name']}"
    )
    rag_block = _rag_block_for(rag_query, level=2, k=8)
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
        "good_examples": rag_block,
        "bad_examples_notes": rag_block,
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
        temperature=0.4,
        timeout=180,
    )
    quests = j.get("quests", [])
    if not quests:
        raise RuntimeError("GPT n'a pas renvoyé de quête")
    q = quests[0]
    choices = q.get("dialogue_choices") or []
    # Force exactement 4 choix : on garde TOUS les best (au moins 1), puis
    # on complète avec les premiers distracteurs, jusqu'à 4 total max.
    best = [c for c in choices if c.get("is_best")]
    others = [c for c in choices if not c.get("is_best")]
    if not best and choices:
        best = [choices[0]]
        others = choices[1:]
        best[0]["is_best"] = True
    choices = best[:1] + others[:3]
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


def bootstrap_corpus(scene_ids: list[str] | None = None) -> dict:
    """Transforme le corpus existant de chaque scène (questions N1 +
    quêtes N2 déjà présentes dans meta.json) en entrées corrections
    « good » par défaut — donne au RAG une base de référence positive
    pour commencer à itérer dès le premier rating.

    Stratégie :
      - Pour chaque question N1 existante (non notée), append 1 entrée
        correction kind=question, rating=good, content=text.
      - Pour chaque quête N2 existante (non notée), 5 entrées :
        - 1 sur le titre (field_title, good)
        - 1 sur l'intro (field_intro, good)
        - 4 sur chaque dialogue_choice (field_choice_text, good +
          is_best correct)
      - Skip les items déjà notés (≠ null) pour ne pas dupliquer.
      - Marque chaque item rétro-notés avec _bootstrapped:True pour
        éviter de les re-bootstrapper.

    Renvoie un dict { scene_id: { n1_added, n2_added } } pour rapport
    à l'éditeur.
    """
    if scene_ids is None:
        scene_ids = [p.name for p in SCENES.iterdir() if p.is_dir() and (p / "meta.json").exists()]
    report = {}
    for sid in scene_ids:
        meta_path = SCENES / sid / "meta.json"
        if not meta_path.exists():
            continue
        # Génère d'abord les descriptions vision pour tous les cadres qui
        # n'en ont pas (factuel, riche, observable). C'est ce qui sera
        # ensuite injecté comme label [cadre: …] dans toutes les corrections.
        try:
            describe_all_boxes(sid, force=False)
            # Re-read meta après que describe_all_boxes l'a modifié
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[bootstrap] describe_all_boxes({sid}) failed: {e}", file=sys.stderr)
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        n1_added = 0; n2_added = 0
        # N1
        for q in meta.get("level1_questions", []):
            if q.get("_bootstrapped") or q.get("_rating"):
                continue
            entry = {
                "date": _now_iso_compat(),
                "scene": sid,
                "level": 1,
                "kind": "question",
                "rating": "good",
                "rating_label": "Bootstrap initial — question conservée par l'auteur",
                "content": q.get("text", ""),
                "choices": " | ".join((q.get("choices") or [])),
                "correct_index": q.get("correct_index", 0),
                "explanation": q.get("explanation", ""),
                "bootstrap": True,
            }
            append_correction(1, entry)
            q["_bootstrapped"] = True
            q["_rating"] = "good"
            q["_note"] = "Bootstrap initial"
            n1_added += 1
        # N2
        for quest in meta.get("quests", []):
            if quest.get("_bootstrapped") or quest.get("_rating"):
                continue
            box_id = str(quest.get("box_id", ""))
            box_obj = next((b for b in meta.get("boxes", []) if str(b.get("id")) == box_id), None)
            box_subject = (box_obj or {}).get("subject", "") if box_obj else ""
            box_description = (box_obj or {}).get("_description", "") if box_obj else ""
            base_ctx = {
                "date": _now_iso_compat(),
                "scene": sid,
                "level": 2,
                "box_id": box_id,
                "box_subject": box_subject,
                "box_description": box_description,
                "quest_title": quest.get("title", ""),
                "intro_text": quest.get("intro_text", ""),
                "bootstrap": True,
            }
            # title
            append_correction(2, {
                **base_ctx, "kind": "field_title", "rating": "good",
                "rating_label": "Bootstrap initial — titre conservé par l'auteur",
                "content": quest.get("title", ""),
            })
            # intro
            append_correction(2, {
                **base_ctx, "kind": "field_intro", "rating": "good",
                "rating_label": "Bootstrap initial — intro conservée par l'auteur",
                "content": quest.get("intro_text", ""),
            })
            # choix
            for c in quest.get("dialogue_choices", []):
                is_best = bool(c.get("is_best"))
                label_text = ("Bootstrap — bonne accroche conservée"
                              if is_best else "Bootstrap — bon distracteur conservé")
                label_expl = ("Bootstrap — bonne explication du best conservée"
                              if is_best else "Bootstrap — bonne explication du distracteur conservée")
                append_correction(2, {
                    **base_ctx, "kind": "field_choice_text", "rating": "good",
                    "rating_label": label_text,
                    "content": c.get("text", ""), "is_best": is_best,
                })
                if c.get("explanation"):
                    append_correction(2, {
                        **base_ctx, "kind": "field_choice_explain", "rating": "good",
                        "rating_label": label_expl,
                        "content": c.get("explanation", ""), "is_best": is_best,
                    })
            quest["_bootstrapped"] = True
            quest["_rating"] = "good"
            quest["_note"] = "Bootstrap initial"
            n2_added += 1
        # Sauve les flags _bootstrapped
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        report[sid] = {"n1_added": n1_added, "n2_added": n2_added}
    return report


def _now_iso_compat() -> str:
    """Pour bootstrap : timestamp ISO compatible avec _now_iso() de server.py."""
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


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
