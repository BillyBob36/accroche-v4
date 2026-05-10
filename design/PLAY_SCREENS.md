# Prompts Claude Design — écrans du mode JEU

Chaque section ci-dessous est un **prompt autonome** prêt à être collé
dans Claude Design (Anthropic Labs). Méthode recommandée :

1. Dans Claude Design, lier le repo `BillyBob36/accroche-v4` (sous-dossier
   `public/` uniquement).
2. Joindre le `DESIGN.md` à la racine.
3. Coller le prompt de l'écran à redessiner.
4. Itérer en mode conversation : « rends ça plus aéré », « le score doit
   être plus dramatique », etc.

> Conseil : commencer par **l'écran 1 (menu de niveau)**, valider l'aesthetic,
> puis enchaîner. Claude Design propage le style entre écrans qui partagent
> un repo + DESIGN.md.

---

## Écran 1 — Menu de niveau

**État** : l'utilisateur vient d'ouvrir un module depuis la bibliothèque.
Master flouté en arrière-plan, modale centrale présente le module.

**Prompt** :

> Redesign the **level menu screen** for a luxury retail sales training
> game. Context: the user just opened a saved scene module. Behind the UI,
> the master scene photograph (a high-end boutique interior with several
> customers) is visible but blurred (blur ~14px, brightness 35%) so the UI
> stays readable.
>
> The screen presents the module name (e.g. "Maison Éclat: Bijouterie
> fine"), a short welcome paragraph ("Cette formation comporte deux niveaux
> …"), then two CTAs:
>
> - **Niveau 1 — Observation** : N questions disponibles · 20s d'observation · 4 questions tirées au hasard.
> - **Niveau 2 — Approche commerciale** : N mini-quêtes à compléter.
>
> A topbar must show: a back link to the library on the left ("← Bibliothèque"),
> the module name centered (truncated on mobile), a small uppercase pill on
> the right indicating the current state ("Préparation").
>
> Aesthetic: warm editorial × cinematic dark, refer to DESIGN.md. Gold accent
> reserved for the module title and the two level CTAs.
>
> **Mobile-first** (375 × 812 baseline). Bottom-sheet feel for the central
> card. Both level CTAs must be ≥ 44 px tall and visually distinct (Niveau 1
> = primary gold, Niveau 2 = secondary outline).
>
> Avoid: status dots, grid of feature cards, fancy gradients on the card.
> The master photo's atmosphere is the gradient.

---

## Écran 2 — Brief Niveau 1

**État** : utilisateur clique « NIVEAU 1 → ». Modale qui annonce la phase
d'observation.

**Prompt** :

> Redesign the **Level 1 brief screen** (observation phase). Same blurred
> master in the background, same topbar pill now reading "Niveau 1 ·
> Observation".
>
> The card content:
>
> - H2: "Niveau 1 — Observation"
> - Paragraph 1: "Vous arrivez sur le pas de la porte d'une boutique. Survolez les personnages pour les identifier, cliquez pour zoomer."
> - Paragraph 2: "Mémorisez : qui est présent, comment ils sont placés, ce qu'ils font. Vous serez interrogé ensuite."
> - Single CTA primary: "Commencer l'observation"
>
> Tone: instructive but premium. The card should feel like the briefing
> screen of a Christopher-Nolan-style mission, not a quiz app. Soft inner
> glow possible at the edges of the card to suggest depth.
>
> Avoid emoji icons; if you want a visual cue, draw a small SVG showing
> two pupils looking at a frame, line stroke 1.8px gold.

---

## Écran 3 — Phase d'observation interactive (NEW BEHAVIOR)

**État** : la modale du brief est fermée. Le master est visible nettement.
Les contours des personnages s'allument au survol. Au clic, l'image B
(perso isolé sur fond bokeh) s'affiche en plein écran. Re-cliquer revient
au master. Pas d'image C dans cette phase.

**Prompt** :

> Redesign the **observation phase view** (Level 1, interactive).
>
> The master scene photograph occupies the full available area (16:9
> landscape on desktop, full-height with horizontal scroll on portrait
> mobile). Top topbar with back link, module name, level pill ("Niveau 1
> · Observation").
>
> A small floating chip top-right shows either "Observation · 20s"
> (countdown) or "Observation libre" (after countdown ended). Style: soft
> background blur, gold border, gold text.
>
> A floating CTA bottom-center (always visible): "Continuer aux questions
> →". Pill shape, gold accent. Tappable area ≥ 44 px tall.
>
> Each character or group on the master has an invisible click zone. On
> hover (desktop) or near-tap (mobile), a single-line **white SVG contour**
> reveals around the character (taken from a pre-generated SVG). Stroke
> 3px, drop-shadow soft white glow. Opacity transitions over 240ms.
>
> On click, a fullscreen overlay opens with the character's "image B" (a
> portrait of the character isolated with creamy bokeh background). The
> image fits within 92vw × 92vh, centered, rest of screen is solid black
> (#050505). Click anywhere on the overlay → it dismisses and we return to
> the master view. **No 1/2 navigation, no Parler button** — that's
> reserved for Level 2 quests.
>
> Important: the contour reveal on hover is the magic moment. Don't make
> the cursor change to pointer until the contour starts showing — let the
> reveal happen first, then the cursor confirms it's clickable.

---

## Écran 4 — Question QCM (Niveau 1)

**État** : après l'observation, des questions s'enchaînent (4 sur le pool).
Stage maître flouté en arrière-plan.

**Prompt** :

> Redesign the **multiple-choice question card** for Level 1.
>
> Layout:
>
> - Tiny uppercase progress label: "Question 1 / 4" (letter-spacing 0.08em)
> - H3 question text (leave room for 2 lines)
> - 4 choice buttons stacked vertically, each ≥ 44 px tall, full-width
> - After selection: clicked button colors green if correct, red if wrong;
>   the correct button (if missed) gets a subtle green border. All buttons
>   become disabled.
> - Below the choices, an explanation block (gold left border 3px, soft
>   gold tint background) with a few lines justifying the answer.
> - A "Suivant →" pill button appears bottom of card, gold accent, only
>   after the user has answered.
>
> Style: card on dark blurred background. Avoid heavy shadows. The
> question must read like a magazine pull-quote, not a survey.
>
> **No score visible during questions** — only revealed at the end.

---

## Écran 5 — Score Niveau 1

**État** : après les 4 questions, le score est affiché.

**Prompt** :

> Redesign the **Level 1 score screen**.
>
> Center of card:
>
> - H2: "Score : 4 / 4" (large, gold)
> - A massive percentage number "100%" (font-size 32-48px, weight 300,
>   gold) — like a luxury watch dial
> - One sentence verdict, varies with score:
>   - 75-100% : "Excellente observation !"
>   - 50-74%  : "Bonne observation, mais quelques détails t'ont échappé."
>   - 0-49%   : "Recommence — l'observation est la première compétence du vendeur."
>
> Two CTAs side by side:
>
> - "← Menu" (secondary, outline)
> - "Niveau 2 →" (primary, gold)
>
> Optional: a subtle progress arc behind the percentage, completed in gold.
> Avoid confetti / sparkle effects — that's children's UI. We want
> "patron de boutique fier de son apprenti".

---

## Écran 6 — Brief Niveau 2

**État** : transition vers le niveau 2. Master flouté + assombri en
arrière-plan.

**Prompt** :

> Redesign the **Level 2 brief screen** (sales-approach quests).
>
> Card content:
>
> - H2: "Niveau 2 — Approche commerciale"
> - "Vous êtes vendeur·se dans cette boutique. Identifiez les opportunités et engagez la conversation avec les clients."
> - A line emphasizing the count: "Complétez les **N mini-quêtes** en cliquant sur les groupes mis en valeur."
> - Tiny progress hint: "Progression : 0 / N"
> - Primary CTA: "Commencer"
>
> The level pill in topbar changes to "Niveau 2 · Approche".
>
> Same look as Level 1 brief; reinforce continuity but suggest higher
> stakes. Maybe a subtle gold glow around the card border.

---

## Écran 7 — Carte des quêtes (Niveau 2)

**État** : master visible nettement, certains groupes/persos pulsent en
or shimmer (les quêtes disponibles). Compteur "Quêtes · 0 / 3" en haut à
droite.

**Prompt** :

> Redesign the **Level 2 quests map**.
>
> Master scene photograph in full visibility. Specific characters/groups
> are outlined with a **golden shimmering single-line contour** (the same
> pre-generated SVG as Level 1, but rendered in gold with a pulsing
> animation: stroke-opacity oscillates 0.55 → 1.0 over 2.4s, with a
> drop-shadow glow that breathes from 4px to 14px gold). Each contour is
> clickable.
>
> Floating chip top-right: "Quêtes · X / N" (gold border, gold text).
>
> Once a quest is completed, its contour stops shimmering and turns soft
> green; the click zone becomes "done" (cursor: not-allowed).
>
> When all quests are done, a gentle transition leads to the end screen.

---

## Écran 8 — Quête : image 1 (contexte)

**État** : on a cliqué sur une quête. L'image B du cadre s'affiche en
plein écran. Une légende explicative est posée en bas. Un bouton
"Parler" en pill doré attend en bas.

**Prompt** :

> Redesign the **quest image-1 view** (context image).
>
> The image (a portrait of one or several characters with creamy bokeh
> background, vertical or square depending on the box ratio) is displayed
> centered, occupying max 92vh / 100% width on mobile. Background of
> screen is near-black (#050505).
>
> Bottom of screen:
>
> - A semi-transparent caption card (max-width 720px, blur backdrop,
>   1px white border 10% opacity, padding 12-16px). Contains the quest
>   intro_text (~60-100 words). Pointer-events: none.
>
> Below the image (or floating bottom-center on mobile):
>
> - Small navigation: "1 / 2" badge in muted, an arrow button "→" to go
>   to image 2 (POV), and a primary pill button "Parler" in gold.
>
> Tap the image itself or the arrow → moves to image 2. Tap "Parler" →
> opens the dialogue modal.

---

## Écran 9 — Quête : image 2 (POV)

**État** : on a cliqué sur la flèche. L'image C (le perso vu depuis la
position du vendeur, avec son expression du moment) remplace l'image 1.

**Prompt** :

> Redesign the **quest image-2 view** (POV / face camera).
>
> Same layout as image-1 but no caption (the player should focus on the
> character's expression — it's the human signal they need to read).
>
> Bottom controls:
>
> - "←" arrow to go back to image 1
> - "2 / 2" badge
> - Primary pill: "Parler" (always present, gold)
>
> Tap "Parler" or the image → opens the dialogue modal.

---

## Écran 10 — Modal de dialogue

**État** : on a cliqué « Parler ». L'image du fond reste visible mais
floutée. Une carte glissée depuis le bas présente 4 répliques au choix.

**Prompt** :

> Redesign the **dialogue modal**.
>
> Triggered by tapping "Parler". The previous image (B or C) stays visible
> but blurred (radius 6-8px) to keep the emotional context.
>
> Card design (slides up from bottom on mobile, centered modal on
> desktop):
>
> - 36×4 px gold drag handle at top-center.
> - H4 title: "[Quest title] — Que dites-vous ?" (gold).
> - 4 dialogue choice buttons stacked. Each button is a soft card with
>   the line of dialogue (1-3 lines). On hover/active, subtle border
>   highlight (white at 18%).
> - On click of a choice:
>   - All buttons become disabled.
>   - Clicked button gets a status state: green if "best", muted if not.
>   - Below the choices, a feedback block appears with:
>     - Small uppercase "★ Meilleur choix" or "Choix possible" badge
>     - 2-3 lines of explanation (left border 3px gold, soft gold tint bg)
>   - A primary pill "Continuer" appears at the bottom of the card.
>
> Tap "Continuer" → modal dismisses, the quest is marked done, return
> to the quests map.
>
> Tone of explanations: pédagogique mais pas paternalisant. Voice of a
> senior boutique manager mentoring a new hire.

---

## Écran 11 — Fin de partie

**État** : toutes les quêtes du niveau 2 complétées.

**Prompt** :

> Redesign the **end-game screen**.
>
> Centered card:
>
> - H2: "Bravo !"
> - "Vous avez complété les N mini-quêtes de ce module."
> - "Continuez à pratiquer — chaque client mérite une approche personnalisée."
> - Two CTAs side by side: "← Menu" (outline), "Bibliothèque" (primary).
>
> Optional: subtle gold particle floating in slow Brownian motion behind
> the card. NO confetti, NO trophy, NO "Level Up" effect.
>
> The mood is "vous avez gagné votre place dans cette maison" — sober
> validation, not arcade celebration.

---

## Itération suggérée

Une fois Claude Design a produit une première passe sur un écran, voici
des questions à se poser pour affiner :

- L'écran fonctionne-t-il à 320 px de large ? (test viewport iPhone SE)
- Le bouton primaire est-il atteignable au pouce ? (zone confort 30-50%
  de la hauteur depuis le bas)
- Y a-t-il une zone "morte" gigantesque sans contenu ? Sur mobile c'est
  OK car bottom-sheet, sur desktop il faut combler élégamment.
- Le contraste texte-fond passe AAA ?
- Que se passe-t-il pendant le chargement de la prochaine image ? (skeleton ?)
- Que se passe-t-il en cas d'erreur réseau ? (retry button visible ?)

## Références consultées

- [Anthropic — Claude Design Get Started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [VentureBeat — Claude Design launch](https://venturebeat.com/technology/anthropic-just-launched-claude-design-an-ai-tool-that-turns-prompts-into-prototypes-and-challenges-figma)
- [awesome-claude-design (rohitg00)](https://github.com/rohitg00/awesome-claude-design) — DESIGN.md template + aesthetic families
- [Anthropic — Prompting for frontend aesthetics](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics)
