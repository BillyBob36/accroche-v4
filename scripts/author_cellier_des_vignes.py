"""Author Level 1 questions + 2 Quests for the 'Cellier des Vignes' scene.

Validates the authoring tool by re-using exactly the same HTTP API the editor
UI calls. Run after the second scene is snapshotted.
"""
from __future__ import annotations

import json
import time
import urllib.request

BASE = "http://localhost:8000"
SCENE_ID = "cellier-des-vignes-boutique-vin"


def api(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw else {}


# ---------- Level 1 questions ----------
LEVEL1 = [
    {
        "id": "q-count",
        "text": "Combien y a-t-il de clients dans la cave à vin ?",
        "choices": ["3", "4", "5", "6"],
        "correct_index": 1,
        "explanation": (
            "Il y a 4 clients : un homme d'affaires en costume gris à gauche, un couple "
            "à la dégustation, une jeune femme près des bouteilles à droite, et un monsieur "
            "âgé près de l'entrée. La sommelière en tablier noir n'est pas comptée."
        ),
    },
    {
        "id": "q-roles",
        "text": "Que fait la femme en tablier noir derrière le bar central ?",
        "choices": [
            "Elle range des bouteilles",
            "Elle sert un verre de vin au couple",
            "Elle prend une commande",
            "Elle nettoie le comptoir",
        ],
        "correct_index": 1,
        "explanation": (
            "C'est la sommelière. Elle est en train de servir un verre au couple en cours "
            "de dégustation. Elle est OCCUPÉE — il est important de comprendre qu'on ne "
            "doit pas la solliciter, mais s'occuper soi-même des autres clients."
        ),
    },
    {
        "id": "q-businessman",
        "text": "Que fait l'homme en costume gris à gauche ?",
        "choices": [
            "Il regarde son téléphone",
            "Il lit un menu",
            "Il examine attentivement une bouteille",
            "Il discute avec quelqu'un",
        ],
        "correct_index": 2,
        "explanation": (
            "Il tient une bouteille en main et l'examine — peut-être l'étiquette, l'année, "
            "le domaine. C'est un signal clair d'intérêt actif : il a un besoin précis, "
            "probablement un bon connaisseur. À aborder en respectant son expertise."
        ),
    },
    {
        "id": "q-young-woman",
        "text": "Quelle est la posture de la jeune femme en cachemire beige ?",
        "choices": [
            "Détendue, en train de discuter",
            "Concentrée, elle lit l'étiquette d'une bouteille",
            "Pressée, elle cherche quelque chose en hâte",
            "Distante, elle ne s'intéresse à rien",
        ],
        "correct_index": 1,
        "explanation": (
            "Elle parcourt les bouteilles avec attention, lisant les étiquettes. "
            "Elle cherche quelque chose de précis sans savoir exactement quoi — peut-être "
            "un cadeau, peut-être un essai. Une cliente parfaite à conseiller."
        ),
    },
    {
        "id": "q-older-gent",
        "text": "Que tient le monsieur âgé près de l'entrée ?",
        "choices": [
            "Une bouteille seule",
            "Un sac en papier",
            "Une caisse en bois de vins",
            "Un verre de dégustation",
        ],
        "correct_index": 2,
        "explanation": (
            "Il porte une caisse en bois de plusieurs vins — sans doute un coffret cadeau "
            "ou une commande déjà préparée. Il pourrait avoir besoin d'aide pour finaliser "
            "ou pour une recommandation supplémentaire."
        ),
    },
    {
        "id": "q-couple-mood",
        "text": "Quelle est l'ambiance entre le couple et la sommelière ?",
        "choices": [
            "Tendue, le couple semble insatisfait",
            "Chaleureuse, le couple est engagé dans la dégustation",
            "Distante, ils ne se parlent pas",
            "Pressée, le couple veut partir",
        ],
        "correct_index": 1,
        "explanation": (
            "Le couple est attentif et la sommelière les sert avec soin. C'est une vente "
            "en cours — laissez-la opérer et concentrez-vous sur les clients qui ont besoin "
            "d'attention ailleurs dans la cave."
        ),
    },
    {
        "id": "q-priority",
        "text": "Selon la scène, quel client devrait-on aborder en PRIORITÉ ?",
        "choices": [
            "Le couple à la dégustation",
            "L'homme d'affaires concentré sur sa bouteille",
            "La jeune femme qui lit les étiquettes",
            "Le monsieur âgé avec la caisse de vins",
        ],
        "correct_index": 3,
        "explanation": (
            "Le monsieur âgé, près de l'entrée, semble chercher quelqu'un — il porte déjà "
            "une caisse, ce qui suggère qu'il est en train de FINALISER un achat ou qu'il "
            "a besoin d'une dernière information. Le couple est avec la sommelière, "
            "l'homme d'affaires se concentre seul, la jeune femme explore. Le risque "
            "que le monsieur reparte sans avoir été aidé est le plus élevé."
        ),
    },
]


# ---------- Quest 1: Le monsieur âgé avec la caisse (box 4) ----------
QUEST_1 = {
    "id": "quest-older-gent",
    "box_id": "4",
    "title": "Le monsieur à la caisse",
    "intro_text": (
        "Un monsieur âgé, élégant, porte une caisse de vins en bois. Il regarde "
        "autour de lui depuis l'entrée — il semble chercher quelqu'un pour finaliser "
        "ou compléter sa sélection. Il a déjà fait son choix principal, mais paraît "
        "hésitant sur un dernier détail. Vous décidez de l'aborder."
    ),
    "image1_prompt": (
        "Same exact photograph. Keep the elderly gentleman in his navy blazer with grey "
        "moustache, holding the wooden wine gift-box, lighting and background pixel-identical. "
        "ONLY MODIFICATION: gently rotate his upper body a few degrees so he is now turning "
        "toward an approaching saleswoman (so the camera sees him slightly more frontal "
        "rather than profile). Same face, same age (~65), same hair, same moustache, same "
        "clothing colour, same wooden box in his hands. DO NOT modify anyone else. "
        "Photorealistic, magazine-quality. No watermark, no text, no logos."
    ),
    "image2_prompt": (
        "Reframe to a tighter portrait of ONLY the elderly gentleman with the grey moustache. "
        "He is photographed from a slight low angle as if seen by a saleswoman approaching "
        "him to help. His expression is OPEN, RELIEVED, slightly smiling — happy that "
        "someone is coming over. Eyebrows lifted in a friendly greeting, eyes making "
        "direct eye contact, lips softly parted as if about to say something. He is still "
        "holding the wooden wine gift-box visibly in front of him. Preserve identity "
        "exactly: same face, same age (~65), same neat grey moustache, same navy blazer. "
        "Match the lighting and creamy bokeh wine-cellar background from the input. "
        "Vertical portrait framing showing him from waist up. Photorealistic, magazine-quality "
        "editorial portrait. No watermark, no text, no logos."
    ),
    "dialogue_choices": [
        {
            "text": "Bonjour Monsieur, je vois que vous avez déjà votre sélection — puis-je vous aider à compléter votre coffret ?",
            "is_best": True,
            "explanation": (
                "★ Excellent. Vous reconnaissez son achat en cours (la caisse) et vous "
                "lui proposez un service précis : compléter sa sélection. C'est une "
                "approche sur-mesure qui valorise son choix existant et ouvre la voie "
                "à une vente additionnelle naturelle."
            ),
        },
        {
            "text": "Bonjour, puis-je vous aider à porter votre caisse ?",
            "is_best": False,
            "explanation": (
                "Bienveillant mais à côté de la plaque. Le client n'a pas demandé d'aide "
                "pour porter — il cherche un conseil. Vous risquez de paraître condescendant "
                "et de le couper de l'opportunité commerciale qu'il vous offre."
            ),
        },
        {
            "text": "Bonjour Monsieur, vous partez ? Puis-je passer votre commande en caisse ?",
            "is_best": False,
            "explanation": (
                "Trop transactionnel. Vous présumez qu'il a fini alors qu'il a clairement "
                "l'air de chercher quelque chose. Vous ratez l'occasion d'une vente "
                "additionnelle et donnez l'impression de le pousser vers la sortie."
            ),
        },
        {
            "text": "Bonjour ! Cette caisse est superbe — c'est pour offrir ?",
            "is_best": False,
            "explanation": (
                "Un compliment correct mais une question intrusive en ouverture. "
                "Le « c'est pour offrir » oblige une réponse personnelle alors que "
                "le client n'a pas encore choisi de partager ce contexte. Préférez "
                "d'abord ouvrir avec un service avant d'entrer dans le particulier."
            ),
        },
    ],
}

# ---------- Quest 2: La jeune femme qui lit les étiquettes (box 3) ----------
QUEST_2 = {
    "id": "quest-young-woman",
    "box_id": "3",
    "title": "La jeune femme qui hésite",
    "intro_text": (
        "Une jeune femme en pull cachemire beige étudie attentivement l'étiquette d'une "
        "bouteille qu'elle a sortie d'un casier. Elle paraît hésiter entre plusieurs "
        "options — elle cherche peut-être un cadeau ou une bouteille pour une occasion "
        "qu'elle ne maîtrise pas. Vous décidez de l'aborder."
    ),
    "image1_prompt": (
        "Same exact photograph. Keep the young woman in her beige cashmere turtleneck "
        "and elegant trousers, lighting and background pixel-identical. ONLY MODIFICATION: "
        "she is now visibly comparing TWO bottles — one in each hand, looking from one "
        "to the other with a thoughtful expression. Wine bottles must look photorealistic "
        "with proper labels (no readable text). Same face, same age (~28), same hair, "
        "same skin tone, same clothing. DO NOT modify anyone else. Photorealistic, "
        "magazine-quality. No watermark, no text, no logos."
    ),
    "image2_prompt": (
        "Reframe to a tighter portrait of ONLY the young woman, photographed three-quarters "
        "from the saleswoman's viewpoint. Her expression is THOUGHTFUL and slightly CONCERNED — "
        "eyebrows softly drawn together, mouth slightly pursed, eyes glancing down toward "
        "an item just out of frame as if still mentally weighing her choice. She is wearing "
        "the same beige cashmere turtleneck. Preserve identity exactly: same face, same age "
        "(~28), same hair, same skin tone. Match the warm wine-cellar lighting and creamy "
        "bokeh background from the input. Vertical portrait framing showing her from "
        "mid-chest up. Photorealistic, magazine-quality editorial portrait. No watermark."
    ),
    "dialogue_choices": [
        {
            "text": "Bonjour, vous hésitez entre deux belles bouteilles — c'est pour une occasion particulière ?",
            "is_best": True,
            "explanation": (
                "★ Excellent. Vous reconnaissez son hésitation visible (deux bouteilles), "
                "vous validez son choix (« deux belles ») et vous ouvrez sur le contexte "
                "qui guidera VOTRE conseil. C'est l'approche idéale d'un sommelier-conseil."
            ),
        },
        {
            "text": "Bonjour, je vous laisse faire votre choix — n'hésitez pas si question.",
            "is_best": False,
            "explanation": (
                "Trop neutre. La cliente est visiblement en train d'hésiter — elle "
                "EXPRIME un besoin de conseil, même silencieusement. Lui dire « je vous "
                "laisse » revient à l'abandonner au moment exact où elle a besoin de vous."
            ),
        },
        {
            "text": "Bonjour, ces deux bouteilles sont parmi nos meilleures, vous ne pouvez pas vous tromper.",
            "is_best": False,
            "explanation": (
                "Trop générique et pas du tout utile. Vous lui dites « tout est bien », "
                "ce qui ne l'aide pas à choisir. Vous ratez l'occasion de la conseiller "
                "réellement et risquez qu'elle prenne celle « par défaut » sans satisfaction."
            ),
        },
        {
            "text": "Bonjour ! Avez-vous votre carte de fidélité ?",
            "is_best": False,
            "explanation": (
                "À éviter en première interaction. Vous parlez administratif/commercial "
                "avant même d'avoir compris son besoin. La cliente, qui cherchait un "
                "conseil, va se sentir traitée comme un numéro et perdre confiance."
            ),
        },
    ],
}


def main() -> None:
    print("→ Saving Level 1 questions…")
    res = api("POST", f"/api/scenes/{SCENE_ID}/meta", {"level1_questions": LEVEL1})
    print(f"   {len(res['meta']['level1_questions'])} questions saved")

    print("→ Saving 2 quests…")
    res = api("POST", f"/api/scenes/{SCENE_ID}/meta", {"quests": [QUEST_1, QUEST_2]})
    print(f"   {len(res['meta']['quests'])} quests saved")

    for qid in (QUEST_1["id"], QUEST_2["id"]):
        print(f"→ Generating images for {qid}…")
        res = api("POST", f"/api/scenes/{SCENE_ID}/quest/{qid}/generate")
        print(f"   started: {res}")
        while True:
            s = api("GET", "/api/status")
            if not s.get("running"):
                if s.get("error"):
                    print(f"   ! error: {s['error']}")
                else:
                    print(f"   ✓ done ({s.get('step')})")
                break
            time.sleep(4)
    print("→ Done.")


if __name__ == "__main__":
    main()
