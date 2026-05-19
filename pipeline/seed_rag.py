"""Seed initial du corpus RAG corrections_n{1,2}.jsonl.

Pré-charge ~25 entrées N2 (accroches de dialogue notées ★/✦/✗) et ~12
entrées N1 (questions d'observation notées ★) inspirées de :
  - l'échange réel avec l'associé (3 cadres de Maison Eclat),
  - les codes du luxe (Robin Lent — Selling Luxury),
  - les profils Bain Luxury (discrétion / ostentation / aspirational…),
  - la théorie générale de la vente assistée (lecture des signaux
    non-verbaux, hospitalité, anticipation).

Chaque entrée porte les NOUVEAUX champs vision (`qui`, `situation`,
`approche_orientation`, `tags`) pour que les matches sémantiques soient
calibrés sur la SITUATION CLIENT autant que sur la phrase.

Lancé via l'endpoint `POST /api/seed-rag` (idempotent : un fichier marqueur
empêche le double-seed). Les embeddings sont calculés à l'append.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ajout du chemin pour les imports relatifs
sys.path.insert(0, str(Path(__file__).resolve().parent))
from generate import append_correction  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
MARKER = DATA / "_seeded_v1.flag"


# --------- Niveau 1 — questions d'observation ---------
# Inspirées des exemples de l'auteur : comptage, identification, lecture
# corporelle, atmosphère, signaux faibles. Toutes notées ★ (good).

N1_SEEDS = [
    {
        "kind": "question", "rating": "good",
        "rating_label": "Comptage simple — ancrage observation de base",
        "content": "Combien de clients sont présents dans la boutique ?",
        "explanation": "Ancrer l'observation par le décompte : avant de lire le comportement, sache QUI est là. Une scène mal comptée est mal lue.",
        "tags": ["comptage", "observation-base"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Comptage par genre — sensibilise à la composition",
        "content": "Combien d'hommes et combien de femmes voyez-vous ?",
        "explanation": "Décomposer par genre prépare la lecture des dynamiques de couple, d'accompagnement et de décision d'achat.",
        "tags": ["comptage", "composition"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Comptage par âge — segment clé en boutique luxe",
        "content": "Combien de personnes paraissent avoir plus de 50 ans ?",
        "explanation": "Le segment senior est souvent le cœur du panier moyen luxe : repérer leur présence oriente immédiatement la posture du vendeur.",
        "tags": ["comptage", "senior", "segmentation"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Identification produit — focus du vendeur",
        "content": "Quel est le produit présenté par la vendeuse au comptoir ?",
        "explanation": "Identifier le produit en cours de présentation indique l'angle de la conversation actuelle et la pièce qui retient l'attention du groupe.",
        "tags": ["identification", "produit", "focus-vendeuse"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Direction du regard — indicateur d'intention #1",
        "content": "Que regarde la dame au fond de la boutique ?",
        "explanation": "Le regard signe l'intention bien avant la parole : repérer ce qu'observe un client donne l'amorce factuelle parfaite pour l'aborder.",
        "tags": ["regard", "intention", "amorce"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Lecture corporelle — confiance",
        "content": "La dame qui entre dans la boutique paraît-elle confiante ?",
        "explanation": "Posture, démarche et regard signent la confiance. Une cliente intimidée demande une approche chaleureuse non commerciale, pas une formule fermée.",
        "tags": ["lecture-corporelle", "confiance", "entree"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Atmosphère de groupe — décodage social",
        "content": "Quelle est l'atmosphère du groupe qui regarde le produit ?",
        "explanation": "Tendue, complice, hésitante, joyeuse : l'atmosphère dicte le registre de l'approche. Forcer une émotion incompatible casse la relation.",
        "tags": ["atmosphere", "groupe", "decodage-social"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Signal faible — montre / pression temporelle",
        "content": "Qui dans la scène consulte sa montre ou son téléphone ?",
        "explanation": "Une montre consultée signale la pression temporelle : adapter — proposer 2 options max, aller droit au but, ne pas multiplier le storytelling.",
        "tags": ["signal-faible", "pression", "temps"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Identification accessoire — indicateur statut",
        "content": "Quel sac porte la cliente qui entre dans la boutique ?",
        "explanation": "Un sac signé, sa qualité, son état signent le code (discrétion/ostentation) et la gamme habituelle de la cliente — sans la juger.",
        "tags": ["accessoire", "code-statut", "sac"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Lecture dynamique — décideur du couple",
        "content": "Dans le couple devant la vitrine, qui semble être le décideur ?",
        "explanation": "Le décideur n'est pas toujours celui qui parle : observer qui ralentit, qui pointe du doigt, qui regarde l'autre pour valider. C'est à lui/elle qu'on adresse l'argument clé.",
        "tags": ["decideur", "couple", "dynamique"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Lecture corporelle — hésitation",
        "content": "Qui paraît hésiter dans le couple devant la bague ?",
        "explanation": "L'hésitation se lit dans la posture pensive, le regard détourné, la main qui touche le menton. C'est le moment où la conversation peut basculer si on l'ouvre bien.",
        "tags": ["hesitation", "couple", "lecture-corporelle"],
    },
    {
        "kind": "question", "rating": "good",
        "rating_label": "Signal faible — alliance",
        "content": "Qui dans la scène porte une alliance visible ?",
        "explanation": "L'alliance ouvre des hypothèses (couple, cadeau pour conjoint, anniversaire) qu'on n'évoque JAMAIS frontalement, mais qui informent silencieusement l'approche.",
        "tags": ["signal-faible", "alliance", "hypothese"],
    },
]


# --------- Niveau 2 — accroches de dialogue ---------
# Chaque "situation" est un cadre client typique. On stocke pour chaque
# cadre 4 accroches (1 ★ best + 3 distracteurs ✗ ou ✦), avec leurs
# explications. Les `qui` / `situation` / `approche_orientation` sont
# rédigés comme le ferait describe_box version nouvelle.

# Helper pour créer une famille de 4 entrées (1 best + 3 distracteurs)
def _quest_seed_block(qui, situation, approche, tags, title, intro,
                       best_text, best_expl, best_label,
                       distractors):
    """Renvoie une liste d'entrées correction N2 pour une situation.
    `distractors` = liste de tuples (rating, text, expl, label) pour chacun
    des 3 distracteurs (rating ∈ {nuanced, refused})."""
    base = {
        "qui": qui, "situation": situation,
        "approche_orientation": approche, "tags": tags,
    }
    out = []
    # Titre + intro = "good" (servent d'inspiration de phrasage)
    out.append({**base, "kind": "field_title", "rating": "good",
                "rating_label": "Titre factuel descriptif",
                "content": title})
    out.append({**base, "kind": "field_intro", "rating": "good",
                "rating_label": "Intro qui pose le signal non-verbal",
                "content": intro})
    # Best choice
    out.append({**base, "kind": "field_choice_text", "rating": "good",
                "is_best": True,
                "rating_label": best_label,
                "content": best_text,
                "note": best_expl})
    out.append({**base, "kind": "field_choice_explain", "rating": "good",
                "is_best": True,
                "rating_label": "Bonne explication du best",
                "content": best_expl})
    # Distracteurs
    for rating, text, expl, label in distractors:
        out.append({**base, "kind": "field_choice_text", "rating": rating,
                    "is_best": False,
                    "rating_label": label,
                    "content": text,
                    "note": expl})
        out.append({**base, "kind": "field_choice_explain", "rating": rating,
                    "is_best": False,
                    "rating_label": "Bonne explication du distracteur",
                    "content": expl})
    return out


N2_SEEDS = []

# ─── Cadre 1 : Dame senior, sac modeste, paraît timide au seuil ───
# (inspiré directement de l'échange avec l'associé)
N2_SEEDS += _quest_seed_block(
    qui="Dame senior 65+, seule, manteau beige, sac modeste, paraît peu habituée au lieu.",
    situation="Au seuil de la boutique, regard balayant timidement, tient son sac à deux mains, intention faible mais curiosité visible. Porte un collier discret de valeur.",
    approche="Cliente intimidée à mettre à l'aise : accueil chaleureux non commercial, compliment indirect sur un détail qu'elle porte, ralentir le rythme.",
    tags=["solo", "senior", "entree", "discretion", "novice", "intention-faible", "signal-intimidation"],
    title="La dame en manteau beige",
    intro="Elle se tient au seuil, son sac serré contre elle. Son regard parcourt la boutique mais elle hésite à avancer.",
    best_text="Bonjour Madame, j'adore votre collier.",
    best_expl="Le compliment indirect sur un détail qu'elle porte la valorise dans le lieu sans la mettre en demeure d'expliquer pourquoi elle est là. Elle se sent reçue, pas évaluée.",
    best_label="Bonne accroche : compliment indirect met à l'aise",
    distractors=[
        ("refused",
         "Bonjour, je suis super gentille, ne soyez pas timide.",
         "Souligne explicitement son malaise et le confirme. La cliente se sent observée dans sa gêne, pas accueillie.",
         "Refusé : verbalise le malaise"),
        ("refused",
         "Bonjour, c'est votre première fois ici non ? Rassurez-vous je suis sympa.",
         "Rappelle indirectement qu'elle dénote du lieu. Renforce le sentiment d'illégitimité au lieu de l'effacer.",
         "Refusé : sous-entend illégitimité"),
        ("refused",
         "Bonjour, en quoi puis-je vous aider ?",
         "Formule fermée, déclenche le réflexe de retrait. Sur un profil intimidé, c'est l'accélérateur du « non merci je regarde ».",
         "Refusé : formule fermée anti-pattern #1"),
    ],
)

# ─── Cadre 2 : Personne au fond regardant une vitrine diamant/or ───
N2_SEEDS += _quest_seed_block(
    qui="Personne adulte, seule, observe avec attention une vitrine de pièces signature (diamant, or).",
    situation="Focus prolongé sur une vitrine précise, posture immobile, regard appuyé sur la pièce centrale. Signaux d'intérêt fort, aucun signe de pression.",
    approche="Profil curieux et attentif : amorcer par le storytelling de la pièce regardée, créer le cérémonial qui élève l'objet au-delà du matériel.",
    tags=["solo", "focus", "ouvert", "discretion", "amateur", "intention-moyenne"],
    title="L'observateur de la vitrine signature",
    intro="Il fixe la pièce centrale de la vitrine, immobile, depuis plusieurs secondes. Son regard cherche un détail précis.",
    best_text="Connaissez-vous l'histoire de cette pièce ?",
    best_expl="Crée un cérémonial : la pièce existe dans une narration, pas dans un prix. C'est le code luxe par excellence (storytelling onirique avant le matériel).",
    best_label="Bon best : storytelling onirique, code luxe",
    distractors=[
        ("nuanced",
         "La pièce du milieu est une création en or 24 carats, je vois que vous avez du goût.",
         "Le compliment indirect est pas mal, mais l'angle « matériel + carats » est trop terre-à-terre pour le luxe — la valeur d'une pièce luxe se raconte, ne se pèse pas.",
         "Nuancé : compliment OK mais angle trop matériel"),
        ("nuanced",
         "Qu'est-ce qui vous intrigue dans cette vitrine ?",
         "Question intrusive et un peu étrange : oblige le client à articuler son ressenti alors qu'il est encore dans la contemplation. Brise la rêverie.",
         "Nuancé : brise la contemplation"),
        ("refused",
         "C'est votre première fois chez nous ?",
         "Sous-entend que la personne dénote du lieu. Crée une distance là où le silence respectueux suffirait.",
         "Refusé : sous-entend illégitimité"),
    ],
)

# ─── Cadre 3 : Couple, homme pensif, femme souriante ───
N2_SEEDS += _quest_seed_block(
    qui="Couple ~35-45 ans, lui pensif visage soucieux, elle souriante posture ouverte, devant les bagues.",
    situation="L'homme observe les pièces avec un visage pensif, mains croisées, regard interne ; la femme sourit légèrement et le regarde lui plus que les bijoux. Signaux mixtes : hésitation côté homme, ouverture côté femme.",
    approche="Couple à dynamique déséquilibrée : ouvrir sur la réflexion de l'homme (le freineur) sans presser, créer un espace de dialogue sans charge émotionnelle.",
    tags=["couple", "hesitant", "ouvert", "neutre", "intention-moyenne", "decideur-mixte"],
    title="Le couple hésitant",
    intro="Lui observe les bagues, sourcils légèrement froncés, mains croisées dans le dos. Elle sourit et le regarde, attendant qu'il prenne la parole.",
    best_text="Vous m'avez l'air pensif, je peux nourrir votre réflexion ?",
    best_expl="Ouvre directement sur l'homme (le freineur visible) en validant son moment de réflexion sans le forcer. Crée du dialogue sans pression ni intrusion.",
    best_label="Bon best : ouvre sur le freineur sans presser",
    distractors=[
        ("refused",
         "Vous regardez une bague pour un heureux événement ?",
         "Intrusif sur un sujet possiblement chargé (mariage, fiançailles peuvent être en tension). Si le sujet est sensible, on plombe l'atmosphère.",
         "Refusé : intrusif sur sujet potentiellement chargé"),
        ("refused",
         "C'est la première fois chez nous ?",
         "Sous-entend que le couple n'est pas client, casse l'ADN d'accueil égalitaire propre au luxe.",
         "Refusé : sous-entend non-client"),
        ("nuanced",
         "Vous êtes mon premier sourire de la journée, c'est agréable.",
         "Bonne intention de chaleur mais sous-entend que tout s'est mal passé avant. Décale la conversation sur le vendeur au lieu du client.",
         "Nuancé : bonne intention, mais centre la conversation sur le vendeur"),
    ],
)

# ─── Cadre 4 : Cliente solo, exploration patiente, code discrétion ───
N2_SEEDS += _quest_seed_block(
    qui="Femme 35-45, solo, soignée, code discrétion luxe (pièces qualité sans marques visibles).",
    situation="Exploration patiente, regard appuyé sur une vitrine précise, posture ouverte, aucune pression. Intention d'achat moyenne, amateur éclairée.",
    approche="Profil amateur éclairé discret : ton sobre, vouvoiement chaleureux, respect du temps (~20-30s), amorce factuelle sur ce qu'elle regarde.",
    tags=["solo", "feminin", "exploration", "ouvert", "discretion", "amateur", "intention-moyenne"],
    title="La cliente discrète",
    intro="Elle s'attarde devant une vitrine, regard appuyé sur une pièce précise. Posture détendue, sans signe de pression.",
    best_text="Cette pièce a retenu votre regard, voulez-vous la voir de plus près ?",
    best_expl="Observation factuelle sur ce qu'elle fait + offre sans imposer. Respecte son temps et son autonomie. Code discrétion : on n'impose pas, on propose.",
    best_label="Bon best : observation factuelle + offre douce",
    distractors=[
        ("refused",
         "Bonjour, puis-je vous aider ?",
         "Formule fermée générique. Sur un profil discret en exploration, déclenche le réflexe « non merci je regarde » et ferme la relation.",
         "Refusé : anti-pattern #1, formule fermée"),
        ("refused",
         "C'est pour offrir ?",
         "Présume le motif. Sur un profil discret, c'est intrusif et ferme la conversation. Une cliente discrète vient pour elle, sauf preuve du contraire.",
         "Refusé : anti-pattern #4, présume le motif"),
        ("nuanced",
         "Cette collection vient de sortir, c'est notre best-seller du mois.",
         "Met le produit avant la cliente. Sur un profil discret, le best-seller sonne commercial et générique — elle veut une rencontre, pas un argumentaire.",
         "Nuancé : trop commercial pour le profil"),
    ],
)

# ─── Cadre 5 : Cadre pressé (montre, costume, regard rapide) ───
N2_SEEDS += _quest_seed_block(
    qui="Homme 35-50 en costume sobre, seul, regarde sa montre, démarche rapide.",
    situation="Phase d'entrée pressée, regard balayant la boutique en quelques secondes, consulte sa montre. Intention forte mais temps contraint.",
    approche="Profil cadre pressé : efficacité, 2 options maximum, aller droit au but. Pas d'errance, pas de storytelling long.",
    tags=["solo", "homme", "presse", "neutre", "expert", "intention-forte", "signal-pression"],
    title="Le cadre pressé",
    intro="Costume sombre, démarche rapide. Il consulte sa montre dès l'entrée et son regard balaye rapidement les vitrines.",
    best_text="Bonjour. Vous avez quelque chose de précis en tête ou je vous oriente en deux minutes ?",
    best_expl="Reconnaît implicitement la contrainte temps en proposant un cadrage clair en 2 options. Efficacité respectée + autonomie laissée. C'est le luxe de l'anticipation.",
    best_label="Bon best : lit la pression, propose un cadrage efficace",
    distractors=[
        ("refused",
         "Bonjour, prenez votre temps de regarder.",
         "Ne lit pas le signal de pression — au contraire, l'aggrave. Le client a 5 minutes, lui dire « prenez votre temps » sonne déconnecté.",
         "Refusé : ignore le signal de pression"),
        ("refused",
         "Je vous laisse regarder tranquillement.",
         "Trop effacé. Sur un profil pressé qui cherche une décision rapide, l'effacement du vendeur le force à se débrouiller seul.",
         "Refusé : anti-pattern #2, trop effacé"),
        ("nuanced",
         "Bonjour, vous cherchez un cadeau ?",
         "Présume le motif. Même s'il est pressé, il peut chercher pour lui. Mieux vaut offrir un cadrage neutre que présumer.",
         "Nuancé : présume le motif"),
    ],
)

# ─── Cadre 6 : Touriste avec sac à dos, regards rapides ───
N2_SEEDS += _quest_seed_block(
    qui="Personne avec sac à dos visible, tenue voyage, regards rapides sur les vitrines, sourire émerveillé.",
    situation="Phase de découverte ludique, prend ponctuellement une photo discrète, regard ouvert balayant l'ensemble. Intention probablement faible (curiosité) mais admiration sincère.",
    approche="Profil touriste curieux : hospitalité, fierté maison, accueil non commercial. Valoriser la maison sans pression de vente.",
    tags=["solo", "touriste", "exploration", "ouvert", "curiosite", "intention-faible", "decouverte"],
    title="Le visiteur curieux",
    intro="Sac à dos, posture détendue. Il observe les vitrines avec un sourire d'admiration et prend discrètement une photo.",
    best_text="Bonjour. Je vois que vous appréciez la maison. Souhaitez-vous que je vous présente notre pièce signature ?",
    best_expl="Hospitalité d'abord, vente jamais. La maison se présente avec fierté à qui l'admire, sans transformer l'admiration en transaction.",
    best_label="Bon best : hospitalité + fierté maison sans pression",
    distractors=[
        ("refused",
         "Les photos sont interdites dans la boutique.",
         "Refus brut sans alternative. Anti-hospitalité totale. Détruit l'image de la maison en 3 secondes.",
         "Refusé : anti-hospitalité"),
        ("refused",
         "Vous voulez acheter quelque chose ou juste regarder ?",
         "Catégorise le visiteur en client/non-client. Sur un touriste curieux, c'est humiliant et contre-productif (le touriste d'aujourd'hui est le client de demain).",
         "Refusé : catégorise le visiteur"),
        ("nuanced",
         "D'où venez-vous ?",
         "Curiosité OK mais trop directe d'entrée — peut être perçue comme intrusive. À garder pour après un premier échange établi.",
         "Nuancé : OK mais trop direct en ouverture"),
    ],
)

# ─── Cadre 7 : Habitué·e senior, démarche directe ───
N2_SEEDS += _quest_seed_block(
    qui="Personne senior, tenue impeccable, démarche directe vers le comptoir, hoche la tête au vendeur connu.",
    situation="Phase d'arrivée d'habitué·e, contact visuel direct avec le personnel, posture confiante. Signaux de familiarité avec le lieu.",
    approche="Profil habitué·e : reconnaissance immédiate par le prénom/nom, anticipation explicite de la raison de la visite, ton chaleureux et personnalisé.",
    tags=["solo", "senior", "habitue", "ouvert", "expert", "intention-forte", "signal-familiarite"],
    title="L'habituée senior",
    intro="Démarche directe, sourire de reconnaissance vers le comptoir. Elle vient sans hésiter, comme à son habitude.",
    best_text="Bonjour Madame Lavigne, ravie de vous revoir. Souhaitez-vous voir la pièce dont nous parlions ?",
    best_expl="Reconnaissance personnelle + anticipation explicite. C'est le code « ANTICIPATION » de Robin Lent : préparer le service avant la demande. Elle se sent unique et attendue.",
    best_label="Bon best : reconnaissance personnelle + anticipation",
    distractors=[
        ("refused",
         "Bonjour, puis-je vous aider ?",
         "Sur un·e habitué·e, c'est une régression : la relation construite est traitée comme une rencontre froide. Vexe potentiellement.",
         "Refusé : ignore la relation établie"),
        ("refused",
         "Bienvenue chez nous, vous découvrez la maison ?",
         "Pire que la formule fermée : prétend ne pas reconnaître la cliente. Sur une habituée, c'est une faute professionnelle.",
         "Refusé : prétend ignorer un habitué"),
        ("nuanced",
         "Bonjour, je vous laisse vous installer, je suis à vous.",
         "Correct techniquement mais manque la chaleur des retrouvailles. La relation client luxe se construit dans le détail personnel, pas la procédure.",
         "Nuancé : correct mais froid pour un habitué"),
    ],
)

# ─── Cadre 8 : Jeune femme aspirational, sourire émerveillé ───
N2_SEEDS += _quest_seed_block(
    qui="Femme 20-30, seule, tenue contemporaine soignée, sourire d'admiration devant les vitrines.",
    situation="Exploration émerveillée, regard qui s'attarde sur les pièces signature, posture ouverte mais respectueuse. Intention probablement aspirational, premier contact avec la maison.",
    approche="Profil aspirational jeune : réassurance sans condescendance, storytelling accessible, ne JAMAIS annoncer le prix d'entrée — éviter de l'intimider.",
    tags=["solo", "feminin", "jeune", "exploration", "ouvert", "novice", "aspirational"],
    title="L'aspirational émerveillée",
    intro="Sourire admiratif devant la collection. Elle s'attarde devant une pièce signature avec respect.",
    best_text="Cette pièce vous plaît ? Elle a une histoire intéressante, je peux vous la raconter.",
    best_expl="Storytelling accessible qui élève la conversation sans annoncer le prix ni l'intimider. Lui permet d'apprendre sans se sentir évaluée.",
    best_label="Bon best : storytelling accessible + réassurance",
    distractors=[
        ("refused",
         "Bonjour, c'est notre nouvelle collection à partir de 2500 euros.",
         "Annonce le prix d'entrée — intimidant sur un profil aspirational jeune. Casse net l'élan d'admiration.",
         "Refusé : prix d'entrée annoncé"),
        ("refused",
         "C'est une belle pièce, mais peut-être un peu chère.",
         "Condescendance manifeste : présume qu'elle n'a pas le budget. Humiliant et stigmatisant.",
         "Refusé : condescendance"),
        ("nuanced",
         "Je suis là si vous voulez essayer une pièce.",
         "Correct mais un peu effacé. Sur un profil émerveillé qui attend une initiation, un peu plus d'engagement aiderait à ouvrir la porte.",
         "Nuancé : correct mais trop effacé pour le profil"),
    ],
)

# ─── Cadre 9 : Homme seul devant les pendentifs (cadeau) ───
N2_SEEDS += _quest_seed_block(
    qui="Homme 30-50, seul, alliance visible, regarde les pendentifs avec hésitation.",
    situation="Phase de focus hésitant, regard prolongé sur les pendentifs, n'ose pas demander. Signaux d'intention forte (cadeau probable pour la conjointe) mais peu d'expertise.",
    approche="Profil cadeau hésitant : ouvrir sur son intention sans la présumer ni l'imposer, offrir le guidage sans jargon technique.",
    tags=["solo", "homme", "focus", "hesitant", "neutre", "novice", "intention-forte", "alliance-visible", "cadeau"],
    title="L'hésitant aux pendentifs",
    intro="Il observe les pendentifs depuis un moment, sans oser appeler le vendeur. Son alliance est visible.",
    best_text="Bonjour. Je vois que les pendentifs vous intéressent, vous avez quelqu'un en tête pour qui choisir ?",
    best_expl="Observation factuelle + ouverture sur l'intention sans présumer la relation (« quelqu'un » plutôt que « votre femme »). Lui donne la main pour préciser.",
    best_label="Bon best : observation + ouverture neutre sur l'intention",
    distractors=[
        ("refused",
         "C'est pour offrir ?",
         "Anti-pattern absolu. Formule banalisée du retail générique, ne s'élève pas au niveau luxe.",
         "Refusé : anti-pattern #4"),
        ("refused",
         "Cherchez-vous un cadeau pour votre femme ?",
         "Présume la relation (peut être une mère, sœur, amie, partenaire de même sexe). Et même si exact, c'est intrusif d'emblée.",
         "Refusé : présume la relation"),
        ("nuanced",
         "Souhaitez-vous voir cette pièce de plus près ?",
         "Correct techniquement mais manque l'ouverture vers son intention. Reste en surface du produit alors qu'il cherche un avis.",
         "Nuancé : reste en surface, n'ouvre pas l'intention"),
    ],
)

# ─── Cadre 10 : Groupe d'amies en exploration joyeuse ───
N2_SEEDS += _quest_seed_block(
    qui="Groupe de 2-3 amies 25-40, complices, rires discrets, exploration ludique de la boutique.",
    situation="Phase d'exploration collective joyeuse, regards qui se croisent et commentent les pièces. Pas de signe de pression. Intention probablement mixte (l'une peut-être plus avancée que les autres).",
    approche="Profil groupe ludique : accueillir collectivement sans cibler une seule personne, donner espace de jeu et de complicité, laisser la dynamique de groupe opérer.",
    tags=["groupe", "feminin", "exploration", "ouvert", "amateur", "ludique"],
    title="Les amies complices",
    intro="Trois amies parcourent la boutique en se passant des commentaires complices. Elles s'arrêtent devant la collection.",
    best_text="Bonjour mesdames, prenez votre temps. Si une pièce vous fait rêver, dites-le moi !",
    best_expl="Accueil collectif sans cibler personne, valide leur dynamique ludique, ouvre un espace sans pression. Le groupe se sent reçu en tant que groupe.",
    best_label="Bon best : accueil collectif, espace ludique préservé",
    distractors=[
        ("refused",
         "Qui d'entre vous achète aujourd'hui ?",
         "Catégorise et brise la complicité du groupe. Une seule devient « cliente », les autres deviennent figurantes — relation cassée.",
         "Refusé : catégorise et casse la complicité"),
        ("refused",
         "C'est pour un événement particulier ?",
         "Présume un motif (mariage, EVJF). Sur un groupe en exploration, c'est intrusif et oriente vers un scénario qu'elles n'ont peut-être pas.",
         "Refusé : présume un motif d'événement"),
        ("nuanced",
         "Bonjour, je vous laisse découvrir ensemble.",
         "Correct mais un peu en retrait. Une touche supplémentaire d'engagement aiderait à signaler la disponibilité chaleureuse.",
         "Nuancé : correct mais un peu en retrait"),
    ],
)


# --------- Orchestration ---------

def seed_corpus(force: bool = False) -> dict:
    """Append toutes les entrées N1 + N2 au corpus RAG. Idempotent :
    skip si le marqueur _seeded_v1.flag existe (sauf si force=True)."""
    if MARKER.exists() and not force:
        return {"skipped": True, "reason": f"marker {MARKER.name} present (déjà seedé)",
                "n1_added": 0, "n2_added": 0}
    # On n'écrit le marqueur QU'à la fin → si l'embedding plante au milieu, on
    # peut relancer sans dupliquer (les fichiers JSONL/MD sont append-only mais
    # ce sont les MÊMES entrées seed donc OK de re-jouer en cas d'échec).
    n1_added = 0
    n2_added = 0
    for entry in N1_SEEDS:
        full = {
            **entry, "scene": "_seed", "level": 1,
            "date": _now(), "bootstrap": True, "seed_v": 1,
        }
        append_correction(1, full)
        n1_added += 1
    for entry in N2_SEEDS:
        full = {
            **entry, "scene": "_seed", "level": 2,
            "date": _now(), "bootstrap": True, "seed_v": 1,
        }
        append_correction(2, full)
        n2_added += 1
    MARKER.parent.mkdir(parents=True, exist_ok=True)
    MARKER.write_text(f"seeded {n1_added} N1 + {n2_added} N2\n", encoding="utf-8")
    return {"skipped": False, "n1_added": n1_added, "n2_added": n2_added,
            "marker": str(MARKER.relative_to(ROOT))}


def _now() -> str:
    import datetime
    return datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


if __name__ == "__main__":
    import json
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="Re-seed même si le marker existe (duplique)")
    args = ap.parse_args()
    r = seed_corpus(force=args.force)
    print(json.dumps(r, ensure_ascii=False, indent=2))
