# Accroche — DESIGN.md

> Système de design pour **Accroche 2.0**, outil de formation interactive
> pour vendeurs de boutiques haut de gamme. Document de référence pour
> Claude Design (Anthropic Labs) et tout outil de génération d'UI.

---

## 0. Contexte produit

- **Public** : vendeurs/conseillers en boutique de luxe (joaillerie, vin,
  prêt-à-porter haut de gamme), souvent novices, qui s'entraînent sur
  smartphone entre deux clients.
- **Modes** : éditeur (création de modules) + player (jeu de formation
  niveau 1 + niveau 2).
- **Plateforme** : web app responsive, **mobile first** (iOS Safari +
  Chrome Android). Desktop = secondaire.
- **Connectivité** : 4G médiocre. Charges ≤ 3 MB par scène, lazy loading.
- **Génération d'images** : pipeline backend Azure GPT-image-2. Le frontend
  consomme les sorties — il ne fait pas d'inférence.

---

## 1. Aesthetic family : **Warm Editorial × Cinematic Dark**

L'app est utilisée dans des boutiques haut de gamme où l'ambiance compte.
On cible un mélange :

- **Warm Editorial** (Claude/Anthropic) : tons chauds, élégance sobre,
  accents dorés mesurés, hiérarchie claire.
- **Cinematic Dark** : fond noir profond pour mettre en valeur les images
  master/zoom (les photographies du module), réflexion contrôlée de la
  lumière, gradients subtils.

**À éviter** : le défaut « SaaS vibrant » (teal #16d5e6, gradients pastel,
status dots animés, container soup, Lucide icon stack, grilles 3-colonnes
de feature cards, étiquettes « Live » qui clignotent).

---

## 2. Colors

```
--bg            : #0a0a0a   (fond app, presque noir, très légèrement chaud)
--bg-elevated   : rgba(20, 20, 22, 0.96)   (cartes, modales, panneaux)
--bg-overlay    : rgba(8, 8, 10, 0.75)      (overlay modale)
--bg-input      : rgba(0, 0, 0, 0.4)        (champs de saisie)

--fg            : #e5e5e5   (texte principal)
--fg-muted      : rgba(255, 255, 255, 0.55) (libellés secondaires, hints)
--fg-faint      : rgba(255, 255, 255, 0.4)  (placeholder, captions)

--accent        : rgba(212, 184, 122, 0.95) (or chaud — tunings dorés)
--accent-soft   : rgba(212, 184, 122, 0.18) (fond bouton accent)
--accent-line   : rgba(212, 184, 122, 0.45) (border bouton accent)

--good          : rgba(80, 227, 164, 0.95)  (bonne réponse, validation)
--bad           : rgba(255, 110, 110, 0.95) (erreur, suppression)
--info          : rgba(140, 200, 255, 0.95) (régénération, action GPT)

--line          : rgba(255, 255, 255, 0.1)  (séparateurs, bordures discrètes)
```

**Règle d'usage de l'or** : l'accent doré est RÉSERVÉ aux éléments
sémantiquement « luxe » : titre du module, lien public, choix « meilleur »
dans une quête, contour shimmer de quête au niveau 2. **Pas** sur les
boutons utilitaires (Sauver / Quitter / Régénérer).

---

## 3. Typography

```
font-family    : system-ui, -apple-system, "Segoe UI", sans-serif

H1 (titre app)         : 28px / weight 300 / letter-spacing 0.01em
H2 (titre écran)       : 24px / weight 300 / accent-color
H3 (titre section)     : 16-17px / weight 400 / fg
Section title (uppercase) : 11px / weight 500 / letter-spacing 0.08em / fg-muted
Body                   : 13-14px / line-height 1.5 / fg
Small / hint           : 11px / fg-muted
Tiny / micro           : 10px / fg-faint

Mobile : tous les inputs >= 14px (évite le zoom auto iOS).
```

Pas de serif ; pas de police custom. La sobriété est délibérée pour
laisser respirer les photographies de la scène.

---

## 4. Spacing

Système 4 px de base, multiples privilégiés : 4, 6, 8, 10, 12, 14, 16, 18,
22, 28, 36.

- **Padding standard d'une carte/modale** : `22px 24px` desktop,
  `18px 18px 28px` mobile (extra bottom pour safe-area iOS).
- **Gap entre champs d'un formulaire** : `8-10px`.
- **Gap entre sections** : `14-18px` + un `<hr>` discret 1px line.
- **Padding bouton** : `10px 14px` desktop, `12-14px` mobile.

---

## 5. Components

### Buttons

| Variante | Fond | Bordure | Texte | Usage |
|---|---|---|---|---|
| `default` | rgba(255,255,255,0.06) | 1px line | fg | Action utilitaire |
| `primary` | accent-soft | 1px accent-line | accent | Action principale d'un écran |
| `info` | rgba(80,180,255,0.18) | 1px info | info | Action GPT (régen, génération) |
| `danger` | transparent + dashed bad | 0 | bad faded | Suppression (volontairement discrète) |

- Border-radius 6px, `text-transform: uppercase` + `letter-spacing: 0.04em`
  sur les boutons primaires.
- **Touch target ≥ 44 × 44 px** sur mobile (WCAG 2.2 / Apple HIG).

### Cards (library / module)

```
border-radius: 10px
border: 1px var(--line)
bg: rgba(255,255,255,0.04)
hover: translateY(-2px) + accent border (180ms ease)
```

Image cover en haut (aspect 16:9, master du module), badge catégorie en
overlay (uppercase 10px).

### Bottom sheets (mobile)

Tous les modaux passent en bottom-sheet sur mobile (`align-items:
flex-end`). Header avec **poignée 36×4 px** centrée en haut. Animation
`slideUp 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards`.

### Top rail (volet rétractable d'outils)

Barre fixe sur le haut de l'écran, rétractable via une poignée
« OUTILS ▾ » centrée. À l'ouverture, expose 6 boutons-outils en grille
3×2 sur mobile (picto seul), 1×6 sur desktop (picto + label).

### Accordion (`<details>`)

Utilisé dans le panneau de cadre pour grouper les options. Chevron `›`
qui pivote 90° à l'ouverture. Header avec hint à droite (état résumé) en
muted.

---

## 6. Icons

- Style : **stroke 1.8px rounded** (similaire à Lucide / Tabler).
- Pas de fill, pas de couleurs ; hérite de `currentColor`.
- 18×18 dans les boutons-outils du rail, 22×22 ailleurs.
- **6 pictos clés** :
  - 〰️ courbe = Tracé
  - 🖼 image = Source (master)
  - ⬚⬚ rectangles = Cadres
  - ◎ cible = Quêtes
  - 👤 humain = Personnages (édition par masque)
  - 📚 étagère = Module (sauver / bibliothèque)

Pas d'emoji UI (les emojis ci-dessus sont des descriptions ; on utilise
des SVG inline).

---

## 7. Animations

- **Transitions courantes** : 150-200ms ease.
- **Modale slide-up** : 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards.
- **Zoom cinématique sur un cadre** : split en deux mouvements distincts
  - stage : `transform translate` 900ms cubic-bezier(0.2, 0.7, 0.3, 1) (la « caméra »)
  - zoom-inner : `transform scale` 1500ms cubic-bezier(0.6, 0, 0.3, 1) + `opacity` 500ms ease 1000ms (le scale finit après l'arrivée caméra ; opacity fade-out delayed pour synchro avec image B fade-in)
- **Shimmer doré niveau 2** :
  ```
  @keyframes shimmer {
    0%,100% { stroke-opacity: 0.55; filter: drop-shadow(0 0 4px rgba(212,184,122,0.4)); }
    50%     { stroke-opacity: 1.0;  filter: drop-shadow(0 0 14px rgba(212,184,122,0.95)); }
  }
  duration: 2.4s ease-in-out infinite
  ```
- **Réduire le motion** si `prefers-reduced-motion` est actif (à
  implémenter — actuellement absent).

---

## 8. Accessibility

**Acquis** :
- WCAG 2.2 touch targets respectés (44px min mobile).
- `<details>` natifs accessibles clavier.
- Contrastes texte sur fond noir ≥ 7:1 pour le fg principal.
- Inputs en 14px+ sur mobile (évite le zoom auto iOS).

**À améliorer** (anti-patterns à corriger) :
- Pas de `prefers-reduced-motion` honoré.
- Pas de `aria-label` sur tous les boutons-icônes (juste sur certains).
- Pas de focus ring custom — le browser default sert, mais peu visible
  sur fond noir.
- Le contour skel des persos en niveau 1 / 2 n'a pas d'alternative non
  visuelle (le hover/clic est la seule interaction proposée).

---

## 9. Layout patterns

### Master scene (image 2560×1440, 16:9)

- **Desktop landscape** : centrée en hauteur, `width: min(100vw, calc(100vh * 2560/1440))`.
- **Mobile portrait** : prend toute la hauteur 100vh, scrollable
  horizontalement avec un slider tactile. Détection : `mobile.active = window.innerHeight > window.innerWidth`.

### Player flow

```
LEVEL MENU → LEVEL 1 BRIEF → OBSERVATION INTERACTIVE → QCM (4 questions
sur 4) → SCORE → LEVEL 2 BRIEF → MASTER + SHIMMER QUÊTES →
QUÊTE 1 (image1 + caption + bouton « Parler ») → DIALOGUE 4 CHOIX →
FEEDBACK + BOUTON « CONTINUER » → repeat → END SCREEN
```

### Editor flow

```
HOME (master + slider mobile) → CLIC SUR PERSO → ZOOM IMAGE B → CLIC →
ZOOM IMAGE C → CLIC → RETOUR HOME

Top rail : TRACÉ / SOURCE / CADRES / QUÊTES / PERSONNAGES / MODULE
- Cadres : entrée directe en mode édition, poignées HTML 28px sur chaque
  cadre, drag pour tracer, clamp ratio ≤3:1, snap16
- Personnages : tracé d'un cadre + brosse pour masque + prompt → édition
  pixel-precise par masque GPT, recollée sans jointure dans le master
```

---

## 10. Anti-patterns (NE PAS faire)

- **Status dots animés** type "online" en haut de carte : non.
- **Container soup** : 3+ niveaux de cards imbriquées, on a max 2.
- **Grilles 3 colonnes de feature cards** sur mobile : non, on est
  toujours en colonne unique sur mobile.
- **Teal #16d5e6** par défaut comme accent : non, l'or est notre
  accent unique.
- **Animations gratuites** sur les transitions de navigation simples
  (passer d'un panel à l'autre n'a pas besoin de fade) : non.
- **Glassmorphism extrême** : on a un peu de blur (8-14px) sur les
  modales et le rail, mais pas sur les cartes ni les boutons. Pas de
  noisy gradient.
- **Lucide stack** non spécifique : nos pictos sont sur-mesure ou
  alignés au sens (humain pour personnages, cible pour quêtes…).
- **Police générique serif** : système sans-serif, point.
- **Border gauche décoratif** sur tous les blocs d'info : seulement sur
  les blocs explication/feedback (gauche or pour pédagogie).

---

## 11. Code references (pour Claude Design)

Le repo public à étudier : <https://github.com/BillyBob36/accroche-v4>.
Sous-dossiers d'intérêt :

- `public/index.html` : éditeur (top rail, modes, modales)
- `public/library.html` : bibliothèque de modules
- `public/play.html` : player (niveau 1 et 2)
- `public/play.js` : logique du jeu
- `public/app.js` : logique éditeur
- `pipeline/` : génération images (n'est pas concerné par le redesign)

⚠️ Ne pas indexer le monorepo entier — pointer Claude Design vers
`public/` uniquement.

---

## 12. Comment utiliser Claude Design avec ce repo

Voir le tutoriel détaillé pas-à-pas : [design/CLAUDE_DESIGN_TUTORIAL.md](design/CLAUDE_DESIGN_TUTORIAL.md)

Et les 11 prompts par écran du mode jeu, prêts à coller dans Claude
Design : [design/PLAY_SCREENS.md](design/PLAY_SCREENS.md)
