# Tutoriel — utiliser Claude Design pour redesigner Accroche

> Pas-à-pas pour passer de notre code actuel (HTML / CSS / JS classique
> dans `public/`) à des écrans redessinés via Claude Design (Anthropic Labs).
> Méthode validée sur la doc officielle Anthropic d'avril 2026.

---

## Sommaire

1. Prérequis
2. Accéder à Claude Design
3. Connecter le repo Git (BillyBob36/accroche-v4)
4. Joindre le DESIGN.md comme référence
5. Lancer un premier prompt (l'écran 1 du jeu)
6. Itérer en mode conversation
7. Exporter le code généré
8. Réintégrer dans le repo
9. Foire aux questions

---

## 1. Prérequis

| Élément | État |
|---|---|
| Compte Claude **Pro / Max / Team / Enterprise** | nécessaire — Claude Design n'est pas accessible sur le plan gratuit |
| Repo Git du projet **public** | ✓ déjà fait : <https://github.com/BillyBob36/accroche-v4> |
| Fichier `DESIGN.md` à la racine du repo | ✓ déjà fait |
| Fichier `design/PLAY_SCREENS.md` avec 11 prompts par écran | ✓ déjà fait |

Si ton compte est sur le plan gratuit, tu peux passer en **Pro** depuis
[claude.ai/settings/billing](https://claude.ai/settings/billing).

---

## 2. Accéder à Claude Design

1. Connecte-toi sur **<https://claude.ai>**.
2. Dans la barre latérale gauche, repère l'icône **palette de peintre** 🎨
   (sous l'icône Chat).
3. Clique. Tu arrives sur l'interface Claude Design.

> Si tu ne vois pas l'icône palette : Claude Design est encore marqué
> « research preview ». Vérifie dans **Settings → Feature preview**
> qu'il est activé pour ton compte.

---

## 3. Connecter le repo Git

C'est l'étape clé pour que Claude comprenne ton code existant et reste
cohérent avec ton aesthetic actuelle.

Dans la zone de saisie de Claude Design, en bas, clique sur l'**icône
trombone 📎** (« Add context »). Un menu s'ouvre avec ces options :

```
↑  Upload .fig file                       [How to download]
ⓘ  Configure GitHub access                [Connect / Disconnect]
🌐 Grab web element
📁 Link code folder                       ← C'est cette option
🛠 Skills and design systems
↻  Reference another project
```

### Étape 3.1 — Authentifier GitHub (une seule fois)

Clique d'abord sur **« Configure GitHub access »** et autorise l'app
GitHub pour Anthropic (OAuth standard, accès en lecture). Une fois
autorisé, le menu affiche `Connected as <ton-user-github>`.

> Cette étape sert UNIQUEMENT à l'authentification — elle ne te demande
> pas encore quel repo. Le repo se choisit à l'étape suivante.

### Étape 3.2 — Lier le dossier de code

Clique sur **« Link code folder »**. Une fenêtre s'ouvre avec :

| Champ | Valeur à entrer |
|---|---|
| **Repository** | `BillyBob36/accroche-v4` |
| **Branch** | `main` |
| **Folder** (très important) | `public` |

> ⚠️ **Restreins bien au sous-dossier `public/`**. Si tu laisses la
> racine, Claude Design indexe aussi `pipeline/` (Python pur), `scripts/`
> (one-off scripts), `pipeline/_imagegen/` (skill Azure) — ça ralentit
> Claude et pollue son contexte avec du code qui n'a rien à voir avec
> le visuel.

Valide. Au bout de quelques secondes, Claude Design affiche les fichiers
indexés. Tu dois voir au moins :
- `index.html` (l'éditeur)
- `library.html` (la bibliothèque)
- `play.html` + `play.js` (le player)
- `app.js` (logique éditeur)

---

## 4. Joindre le DESIGN.md comme référence

⚠️ Petit hic : tu as restreint l'indexation à `public/` pour que Claude
ne ralentisse pas → mais le `DESIGN.md` est à la **racine** du repo, pas
dans `public/`. Donc Claude Design ne le voit pas via le « Link code
folder » fait à l'étape 3.

**Solution** : copie-le manuellement en début de conversation. Deux
options :

### Option A — Copier-coller le contenu

1. Ouvre `DESIGN.md` dans ton IDE local.
2. Copie tout le contenu (Ctrl+A, Ctrl+C).
3. Colle-le comme **premier message** dans Claude Design, précédé de :

   > « Voici les règles de design que tu dois respecter pour tout ce
   > que tu vas générer. Source de vérité ABSOLUE. »

### Option B — Lien GitHub direct

1. En premier message, écris :

   > « Lis ce fichier : <https://github.com/BillyBob36/accroche-v4/blob/main/DESIGN.md>
   > et applique-le strictement à toutes les générations. »

2. Claude Design fetche le contenu et l'utilise.

L'option A est plus fiable (Claude a tout en contexte direct, pas de
risque de fetch raté).

### Instruction explicite à Claude

Ensuite, dis-lui :

   > « Toutes les règles de design (couleurs, typographie, spacing,
   > composants, animations, anti-patterns) sont dans le DESIGN.md
   > attaché. Respecte-le strictement. Pour chaque écran que je vais
   > demander, justifie chaque choix par une référence à une section du
   > DESIGN.md. »

   Cette instruction explicite empêche Claude de retomber sur ses
   defaults (teal #16d5e6, gradients pastel, etc.) — c'est un risque
   documenté dans `awesome-claude-design`.

---

## 5. Lancer un premier prompt — l'écran 1 du jeu

Ouvre `design/PLAY_SCREENS.md` dans ton IDE local.

1. Copie **tout le bloc de l'« Écran 1 — Menu de niveau »** (le contenu
   entre les `> ` markdown — c'est le prompt).
2. Colle-le dans Claude Design comme premier message.
3. Avant d'envoyer, ajoute en préambule :

   > « Cible : `play.html` + `play.js` actuellement dans `public/`.
   > Garde la mécanique JS existante (level menu → start-1 / start-2
   > buttons, etc.). Ne re-design QUE le visuel et le HTML structurel. »

4. Envoie.

Claude génère un premier prototype en 30-60 secondes. Tu vois :
- Une preview live à droite
- Le code généré (HTML + CSS + un peu de JS) à gauche
- Des suggestions de tweak en bas

---

## 6. Itérer en mode conversation

Claude Design est conversationnel. Quelques prompts utiles pour affiner :

| Intention | Prompt à coller |
|---|---|
| Plus aéré | « Ajoute 1.5× plus d'air vertical entre le titre, la description et les CTAs. » |
| Plus sobre | « Trop chargé. Retire toute ombre, tout gradient. Rester strictement dans la palette du DESIGN.md. » |
| Mobile en priorité | « Désigne d'abord le breakpoint 375×812 (iPhone SE). Puis adapte au desktop ≥1280px. » |
| Cohérence d'écran | « L'écran que tu viens de créer doit partager EXACTEMENT le même header (back link + module name + level pill) que les écrans précédents. Réutilise. » |
| Anti-générique | « Trop générique 'AI SaaS dashboard'. On vise 'maison de luxe parisienne'. Inspirations : Goyard, Hermès, Charvet. » |
| Animation | « Ajoute une transition slideUp 280ms cubic-bezier(0.4, 0, 0.2, 1) forwards quand le card apparaît. » |

**Règle d'or** : ne demande pas tout en un seul prompt. Itère par
**petites passes** de 1-2 modifications à la fois.

---

## 7. Exporter le code généré

Une fois un écran satisfaisant :

1. Clique sur **Code view** (icône `< >` en haut à droite de la preview).
2. Tu vois le code complet — HTML, CSS (souvent inline ou dans une
   `<style>`), et éventuellement JS de coordination.
3. Bouton **Export** :
   - **Copy code** : tout dans le presse-papier
   - **Download as ZIP** : pour un export plus complet (avec assets)
   - **Open in editor** : ouvre dans un nouvel onglet code-only

Pour notre cas, **Copy code** suffit.

---

## 8. Réintégrer dans le repo

C'est l'étape la plus délicate. Le code généré par Claude Design n'est
pas directement compatible avec notre `play.html` existant. Voici la
méthode :

### Étape 8.1 — Identifie l'écran cible dans `play.js`

Chaque écran dans le mode jeu correspond à un appel à `setScreen(html)` ou
à une vue spécifique dans `play.html`. Exemples :

| Écran (PLAY_SCREENS.md) | Localisation actuelle |
|---|---|
| 1. Menu de niveau | `showLevelMenu()` dans `play.js` |
| 2. Brief Niveau 1 | `startLevel1()` dans `play.js` |
| 3. Observation interactive | `runObservationPhase()` + master visible |
| 4. Question QCM | `showQuestion()` dans `play.js` |
| 5. Score Niveau 1 | `showScore()` dans `play.js` |
| 6. Brief Niveau 2 | `startLevel2()` dans `play.js` |
| 7. Carte des quêtes | `enterQuestMap()` + `renderQuestLayer()` |
| 8. Quête image 1 | `showQuestImage()` dans `play.js` (idx=1) |
| 9. Quête image 2 | `showQuestImage()` dans `play.js` (idx=2) |
| 10. Modal de dialogue | `openDialogue()` dans `play.js` |
| 11. Fin de partie | `showLevel2Score()` dans `play.js` |

### Étape 8.2 — Remplace le contenu HTML, garde le contenu JS

Le code Claude Design contient :
- Du **HTML structurel** → c'est ça qui remplace ce qu'on a aujourd'hui
- Du **CSS** → à intégrer dans `play.html` (ou un nouveau fichier)
- Des **handlers JS** → à harmoniser avec ceux de `play.js`

Pour l'écran 1 (`showLevelMenu`), par exemple :

```js
// AVANT — dans play.js, fonction showLevelMenu()
setScreen(`
  <h2>${game.scene.name}</h2>
  <p>Bienvenue. Cette formation comporte deux niveaux …</p>
  ...
  <button class="btn" id="start-1">Niveau 1 →</button>
  <button class="btn secondary" id="start-2">Niveau 2 →</button>
`);
$('start-1').addEventListener('click', startLevel1);
$('start-2').addEventListener('click', startLevel2);
```

```js
// APRÈS — colle le HTML généré par Claude Design (sans toucher aux IDs
// 'start-1' et 'start-2', ils sont obligatoires pour le binding JS).
setScreen(`
  <!-- HTML généré par Claude Design -->
  <article class="level-menu-card">
    <header>...</header>
    <div class="level-cta-stack">
      <button class="cta-primary" id="start-1">Niveau 1 →</button>
      <button class="cta-secondary" id="start-2">Niveau 2 →</button>
    </div>
  </article>
`);
$('start-1').addEventListener('click', startLevel1);
$('start-2').addEventListener('click', startLevel2);
```

**Règle critique** : conserve les IDs `start-1`, `start-2`, `go-observe`,
`qcm-next`, `qcm-explain`, `quest-counter`, `talk-btn`, `dialogue-close`
etc. — ils sont **utilisés par `play.js`**. Si tu les renommes, le jeu
casse.

### Étape 8.3 — Intègre le CSS

Trois options selon la taille du CSS :

- **Petit (< 30 lignes)** : inline dans le `setScreen()` via `<style>`
- **Moyen (30-100 lignes)** : ajoute dans la `<style>` globale de `play.html`
- **Gros (> 100 lignes)** : nouveau fichier `public/play.css`, link dans `play.html`

### Étape 8.4 — Teste localement

```
python server.py
# puis http://localhost:8000/play.html?scene=cellier-des-vignes-boutique-vin
```

Vérifie que :
- Le HTML s'affiche correctement
- Les IDs JS sont bien câblés (clic sur Niveau 1 démarre bien l'observation)
- Le rendu mobile (Chrome DevTools, mode responsive) reste cohérent
- `prefers-reduced-motion` est honoré (sinon, animation à corriger)

### Étape 8.5 — Commit + push

```bash
git add public/play.html public/play.js
git commit -m "Refonte écran 1 (menu niveau) via Claude Design"
git push
```

Le déploiement Coolify se fait automatiquement (ou via la commande
documentée dans `memory/coolify_deploy.md`).

---

## 9. FAQ

**Q. Faut-il refaire DESIGN.md à chaque session ?**
Non. Tant que tu travailles sur le même produit, le DESIGN.md à la racine
du repo suffit. Tu peux l'enrichir avec le temps (notamment la section
Anti-patterns au fur et à mesure que tu repères des regrets).

**Q. Combien d'écrans en parallèle dans une même conversation Claude
Design ?**
Maximum 2-3, sinon le contexte se dilue. Préfère **une conversation par
écran**. Tu peux ouvrir plusieurs onglets Claude.

**Q. Et si Claude Design propose un design qui ignore le DESIGN.md ?**
Reformule explicitement : « Tu n'as pas respecté la section Spacing du
DESIGN.md (système 4px, gap entre champs 8-10px). Ré-applique cette
règle. ». Souvent une seconde passe suffit.

**Q. Le code Claude Design utilise React/Tailwind, mon repo est en
HTML+CSS classique. Comment faire ?**
Demande explicitement : « Génère le code en **HTML + CSS vanilla**, sans
framework, sans Tailwind, sans React. Une seule balise `<style>` inline
ou attachée. ». Claude obtempère.

**Q. Je veux animer l'apparition d'un écran. Comment ?**
Le DESIGN.md contient déjà la transition `slideUp 280ms cubic-bezier(0.4,
0, 0.2, 1) forwards` standard. Demande à Claude « Applique la transition
standard du DESIGN.md à l'apparition de la card. ».

**Q. Comment tester le rendu mobile **avant** de pousser en prod ?**
Localement avec Chrome DevTools (F12 → mode responsive 375×812). Le
serveur local `python server.py` sert l'app sur `localhost:8000`.

---

## Références

- [Anthropic — Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Anthropic Labs — Introducing Claude Design](https://www.anthropic.com/news/claude-design-anthropic-labs)
- [awesome-claude-design (templates DESIGN.md + aesthetic families)](https://github.com/rohitg00/awesome-claude-design)
- [Claude Cookbook — Prompting for frontend aesthetics](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics)

Le `DESIGN.md` et les 11 prompts dans `design/PLAY_SCREENS.md` ont été
conçus selon ces sources : 9 sections canoniques + aesthetic family
explicite + anti-patterns documentés.
