"""Author Level 1 questions + Quest 1 for 'Maison Éclat: Bijouterie fine'.

Uses the same HTTP API the in-page editor uses, so this exercises the tool
end-to-end. Run after the server is up at localhost:8000.
"""
from __future__ import annotations

import json
import time
import urllib.request
import urllib.parse

BASE = "http://localhost:8000"
SCENE_ID = "maison-eclat-bijouterie-fine"


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else {}


# ---------- Level 1 questions ----------
LEVEL1 = [
    {
        "id": "q-count",
        "text": "Combien y a-t-il de clients dans la boutique ?",
        "choices": ["3", "4", "5", "6"],
        "correct_index": 2,
        "explanation": (
            "Il y a 5 clients : un couple au centre, une grand-mère en train d'examiner "
            "un bijou, une dame aux cheveux blancs qui regarde vers la gauche, et une "
            "femme à droite près d'un comptoir. La vendeuse n'est pas comptée."
        ),
    },
    {
        "id": "q-gender",
        "text": "Combien y a-t-il d'hommes et de femmes parmi les clients ?",
        "choices": ["1 homme, 4 femmes", "2 hommes, 3 femmes", "0 homme, 5 femmes", "3 hommes, 2 femmes"],
        "correct_index": 0,
        "explanation": (
            "Un seul homme (dans le couple) et 4 femmes : sa compagne, la grand-mère, "
            "la dame aux cheveux blancs et la femme à droite. Bien repérer la composition "
            "permet d'adapter son discours et ses recommandations."
        ),
    },
    {
        "id": "q-senior",
        "text": "Combien de personnes paraissent avoir 50 ans ou plus ?",
        "choices": ["1", "2", "3", "4"],
        "correct_index": 1,
        "explanation": (
            "La grand-mère et la dame aux cheveux blancs : 2 clientes seniors. "
            "Cette catégorie est souvent en recherche de bijoux durables, intemporels — "
            "un argument à mettre en avant."
        ),
    },
    {
        "id": "q-product",
        "text": "Quel type de produit est mis en valeur au centre de la scène ?",
        "choices": [
            "Une montre de luxe",
            "Un collier ou une parure",
            "Une bague de fiançailles",
            "Une paire de boucles d'oreilles",
        ],
        "correct_index": 1,
        "explanation": (
            "Au centre, c'est un bijou de cou (collier / parure) qui est présenté par "
            "la vendeuse au groupe central. Ce produit peut servir d'amorce de conversation "
            "avec les clients qui hésitent ailleurs dans la boutique."
        ),
    },
    {
        "id": "q-back-lady",
        "text": "Que regarde la dame aux cheveux blancs au fond ?",
        "choices": [
            "Le bijou présenté par la vendeuse",
            "La sortie",
            "Une vitrine sur sa gauche",
            "Le couple au centre",
        ],
        "correct_index": 2,
        "explanation": (
            "Elle regarde vers la gauche, en direction d'une vitrine — pas vers le groupe "
            "central. C'est le signe d'une cliente intéressée par autre chose : excellente "
            "occasion d'aller la rejoindre pour comprendre ce qui l'attire."
        ),
    },
    {
        "id": "q-confidence",
        "text": "La femme à droite, près de l'entrée, semble-t-elle à l'aise dans la boutique ?",
        "choices": [
            "Très à l'aise, comme une habituée",
            "Hésitante, un peu intimidée",
            "Pressée, comme si elle cherchait quelqu'un",
            "Indifférente, juste de passage",
        ],
        "correct_index": 1,
        "explanation": (
            "Sa posture est légèrement réservée : c'est une cliente potentielle qui ne "
            "veut pas être brusquée. Une approche douce, sans pression, est ici la clé."
        ),
    },
    {
        "id": "q-central-mood",
        "text": "Quelle est l'ambiance du groupe central (couple + vendeuse) ?",
        "choices": [
            "Tendue, le client semble vouloir partir",
            "Détendue, complice, le couple est intéressé",
            "Froide, la vendeuse insiste trop",
            "Distante, le couple regarde ailleurs",
        ],
        "correct_index": 1,
        "explanation": (
            "L'échange est complice : le couple est engagé dans la présentation. "
            "C'est une vente avancée — laissez la vendeuse en place finir son travail "
            "et concentrez-vous sur les autres clients qui ont besoin d'attention."
        ),
    },
]


# ---------- Quest 1: La grand-mère (box 3) ----------
QUEST_1 = {
    "id": "quest-1",
    "box_id": "3",
    "title": "La grand-mère",
    "intro_text": (
        "Une cliente d'un certain âge, élégante, observe attentivement un collier doré "
        "exposé en vitrine. Elle ne s'est pas encore tournée vers vous. Vous décidez "
        "de l'aborder."
    ),
    "image1_prompt": (
        "Same exact photograph. Keep ALL existing people, lighting, framing, and "
        "background pixel-identical. ADD a delicate fine gold necklace with a small "
        "pendant resting visibly on the elderly lady's neckline (the woman with white "
        "or grey hair, age 60+, the visible client). The necklace should look like a "
        "luxury jewellery piece she has just been admiring — fine chain, tasteful, "
        "warm gold tone catching the boutique's golden ambient light. DO NOT modify "
        "her face, her hair, her clothing colour, her pose, or anyone else in the "
        "image. ONLY add the necklace as if photographed in the same shot. "
        "Photorealistic, magazine-quality fashion editorial. No watermark, no text."
    ),
    "image2_prompt": (
        "Reframe to a tighter portrait of ONLY the elderly lady (the woman with "
        "white/grey hair) seen from the saleswoman's viewpoint as she approaches. "
        "Her facial expression must be RESERVED, polite but cool — slightly closed-off "
        "body language, not yet smiling, neutral mouth, evaluating gaze. She is wearing "
        "the same fine gold necklace from the previous shot. Preserve identity exactly: "
        "same face, same age, same hair, same skin tone, same clothing. Match the lighting "
        "and creamy bokeh boutique background from the input. Vertical portrait framing "
        "showing her from mid-chest up. Photorealistic, high resolution, magazine-quality "
        "editorial portrait. No watermark, no text, no logos."
    ),
    "dialogue_choices": [
        {
            "text": "Bonjour Madame, j'adore votre collier !",
            "is_best": True,
            "explanation": (
                "★ Excellent. Un compliment authentique et précis sur un détail "
                "personnel ouvre la conversation sans pression commerciale. La cliente "
                "se sent vue comme une personne, pas comme un porte-monnaie. C'est "
                "l'amorce idéale pour basculer naturellement vers le bijou qui l'attire."
            ),
        },
        {
            "text": "Bonjour Madame, puis-je vous aider à trouver quelque chose ?",
            "is_best": False,
            "explanation": (
                "Trop générique — cette phrase est utilisée partout et déclenche un "
                "réflexe de défense (« non merci, je regarde »). À éviter en boutique de luxe."
            ),
        },
        {
            "text": "Madame, ce collier vous irait à merveille — voulez-vous l'essayer ?",
            "is_best": False,
            "explanation": (
                "Trop direct et prématuré. Vous n'avez pas encore créé de lien : "
                "la cliente perçoit un argumentaire de vente plutôt qu'une vraie "
                "écoute. Risque de la braquer."
            ),
        },
        {
            "text": "Bonjour Madame, prenez votre temps, je suis là si besoin.",
            "is_best": False,
            "explanation": (
                "Poli mais passif. Vous laissez la cliente seule alors qu'elle "
                "exprime déjà un intérêt visible. Une approche plus engagée, sans "
                "pression, aurait été plus efficace."
            ),
        },
    ],
}


def main() -> None:
    print("→ Fetching current scene meta…")
    meta = api("GET", f"/api/scenes/{SCENE_ID}")
    print(f"   {meta['name']} — {meta['box_count']} cadres, "
          f"{len(meta.get('level1_questions', []))} questions, "
          f"{len(meta.get('quests', []))} quêtes")

    print("→ Saving Level 1 questions…")
    res = api("POST", f"/api/scenes/{SCENE_ID}/meta", {"level1_questions": LEVEL1})
    print(f"   updated={res.get('updated')} — questions: {len(res['meta']['level1_questions'])}")

    print("→ Saving Quest 1 (la grand-mère)…")
    quests = list(meta.get("quests", []))
    # Replace if quest-1 already exists
    quests = [q for q in quests if q.get("id") != "quest-1"]
    quests.append(QUEST_1)
    res = api("POST", f"/api/scenes/{SCENE_ID}/meta", {"quests": quests})
    print(f"   updated={res.get('updated')} — quests: {len(res['meta']['quests'])}")

    print("→ Triggering image generation for quest-1…")
    res = api("POST", f"/api/scenes/{SCENE_ID}/quest/quest-1/generate")
    print(f"   started: {res}")
    # Poll until done
    while True:
        s = api("GET", "/api/status")
        print(f"   ... running={s.get('running')} step={s.get('step')!r}")
        if not s.get("running"):
            if s.get("error"):
                print(f"   ! error: {s['error']}")
            break
        time.sleep(3)
    print("→ Done.")


if __name__ == "__main__":
    main()
