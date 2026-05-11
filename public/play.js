'use strict';

// ===================================================================
//   Accroche · Player
//   Levels:
//     1 - Observation (brief, 20s timer, 4/N random QCM, score)
//     2 - Sales-approach quests (master with shimmering quests, click,
//         image1 -> "Parler" -> image2 dialogue, repeat for each quest)
// ===================================================================

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);

const params = new URLSearchParams(location.search);
const sceneId = params.get('scene');
// `from=library` est ajouté UNIQUEMENT par la bibliothèque sur le bouton
// "Jouer". Sur un lien public (copié via "🔗 Lien public"), ce paramètre
// est absent → le joueur n'a pas accès au bouton « ← Bibliothèque » ni
// au bouton « Bibliothèque » de l'écran de fin. Permet d'avoir une
// expérience "guest" propre pour les liens partagés.
const fromLibrary = params.get('from') === 'library';

const LEVEL1_QUESTION_COUNT = 4;       // pick N random from the pool
const LEVEL1_TIMER_SECONDS = 20;       // observation duration

const game = {
  scene: null,
  level: 0,
  questions: [],     // selected for this run
  qIdx: 0,
  score: 0,
  level1Done: false,
  questsDone: new Set(),
  currentQuestId: null,
  currentQuestImage: 1, // 1 or 2
};

// ---------- helpers ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function setScreen(html) {
  const wasShown = $('screen').classList.contains('shown');
  $('screen-panel').innerHTML = html;
  $('screen').classList.add('shown');
  // Joue un son de transition seulement quand on PASSE d'un écran à un autre.
  if (!wasShown) sfx('transition');
}
function hideScreen() { $('screen').classList.remove('shown'); }

function setLevelPill(text) { $('level-pill').textContent = text; }

function blurStage(yes) { document.body.classList.toggle('blurred', yes); }

// ============== Zoom cinématique vers un box (split pan + scale) ============
// Reproduit l'effet de l'éditeur : le stage TRANSLATE (caméra) en 900 ms,
// pendant que le zoom-inner SCALE en 1500 ms et fade-out à 1000 ms (à ce
// moment-là l'overlay prend le relais via son fade-in delayed). C'est le
// même pattern que `applyZoom` dans app.js.
const MASTER_W_PLAY = 2560, MASTER_H_PLAY = 1440;

function applyZoomToBox(box) {
  sfx('zoom_in');
  const stage = $('stage');
  const zi = $('zoom-inner');
  const wrap = $('stage-wrap');

  // Pendant l'animation, le scroll horizontal du stage-wrap (mode mobile
  // portrait) doit être verrouillé pour ne pas perturber la caméra.
  wrap.style.overflow = 'hidden';

  // Lit la position/dimensions actuelles du stage (sans transform).
  stage.style.transition = 'none';
  zi.style.transition = 'none';
  // On force un reflow pour que le clear de transform prenne effet
  stage.style.transform = '';
  zi.style.transform = '';
  void stage.offsetWidth;

  const r = stage.getBoundingClientRect();
  const stageW = r.width, stageH = r.height;
  // Coords du centre du box dans le repère stage (px).
  const bcx = (box.x + box.w / 2) / MASTER_W_PLAY * stageW;
  const bcy = (box.y + box.h / 2) / MASTER_H_PLAY * stageH;
  const bw = box.w / MASTER_W_PLAY * stageW;
  const bh = box.h / MASTER_H_PLAY * stageH;

  // Scale : que le box rentre confortablement dans le viewport (85 % pour
  // laisser une marge), avec un minimum de 1.4 (sinon ça ne se voit pas).
  let scale = Math.min(window.innerWidth / Math.max(1, bw),
                       window.innerHeight / Math.max(1, bh)) * 0.85;
  if (scale < 1.4) scale = 1.4;
  if (scale > 6) scale = 6;

  // Pan : amener le centre du box au centre du viewport.
  const panX = window.innerWidth / 2 - r.left - bcx;
  const panY = window.innerHeight / 2 - r.top - bcy;

  // Restaure les transitions CSS et applique les transforms.
  stage.style.transition = '';
  zi.style.transition = '';
  // Camera (translate, 900 ms ease-out)
  stage.style.transform = `translate(${panX}px, ${panY}px)`;
  // Scale (1500 ms) — origin sur le centre du box pour un zoom propre
  zi.style.transformOrigin = `${bcx}px ${bcy}px`;
  zi.style.transform = `scale(${scale})`;
  document.body.classList.add('zooming-in');
}

function resetZoomToHome() {
  sfxReverse('zoom_in');  // joue le son du zoom à l'envers pour marquer le dézoom
  const stage = $('stage');
  const zi = $('zoom-inner');
  const wrap = $('stage-wrap');
  document.body.classList.remove('zooming-in');
  stage.style.transition = '';
  zi.style.transition = '';
  // Le master fade-in instantanément (delay 0), pendant que le scale revient
  // à 1 sur 1500 ms autour du même origin (pour ne pas pop au coin).
  stage.style.transform = '';
  zi.style.transform = '';
  setTimeout(() => {
    if (!document.body.classList.contains('zooming-in')) {
      zi.style.transformOrigin = '';
      wrap.style.overflow = '';
    }
  }, 1600);
}

// ---------- bootstrap ----------
async function init() {
  if (!sceneId) {
    setScreen(`<h2>Aucun module sélectionné</h2><p>Reviens à la <a href="library.html" style="color:var(--accent);">bibliothèque</a> et choisis un module.</p>`);
    return;
  }
  let r;
  try { r = await fetch(`/api/scenes/${encodeURIComponent(sceneId)}`); }
  catch { return setScreen('<h2>Erreur réseau</h2><p>Impossible de charger le module.</p>'); }
  if (!r.ok) {
    return setScreen(`<h2>Module introuvable</h2><p>Identifiant : ${sceneId}</p>`);
  }
  game.scene = await r.json();
  $('scene-name').textContent = game.scene.name;
  $('master').src = `scenes/${sceneId}/${game.scene.master_filename || 'master.jpg'}`;
  // Lien public : on cache le bouton « ← Bibliothèque » du topbar.
  if (!fromLibrary) {
    const libBtn = document.querySelector('.topbar a[href="library.html"]');
    if (libBtn) libBtn.remove();
  }
  // Applique le style du tracé sauvegardé dans le module (cf. l'éditeur).
  // Sans ça, les contours du player ont un style fixe (3 px, opacité 0.92,
  // pas de glow) qui peut différer de ce qu'a réglé l'auteur dans l'éditeur.
  applyTraceStyle(game.scene.trace_style);
  // Welcome screen → choose level
  showLevelMenu();
}

// ============== AUDIO : helper sfx(event) ============================
// Joue le son associé à l'event via AccrocheSFX (cf. sfx.js). On lit le
// mapping meta.sounds + le flag meta.sounds_enabled du module en cours.
// Si AccrocheSFX n'est pas chargé ou si sounds_enabled=false, no-op.
function sfx(event) {
  if (!window.AccrocheSFX) return;
  if (!game.scene) return;
  if (game.scene.sounds_enabled === false) return;
  try { window.AccrocheSFX.playSound(event, game.scene.sounds || {}); } catch {}
}
// Joue le preset associé à `event` À L'ENVERS. Utilisé pour le dezoom :
// le même son que le zoom, joué backwards, marque le retour à la scène.
function sfxReverse(event) {
  if (!window.AccrocheSFX || !window.AccrocheSFX.playReversed) return;
  if (!game.scene) return;
  if (game.scene.sounds_enabled === false) return;
  try { window.AccrocheSFX.playReversed(event, game.scene.sounds || {}); } catch {}
}

// Délégation : tout clic sur un bouton or primaire joue le son ui_cta.
// Selectors couverts : .screen .btn (welcome/brief/score), .talk-btn (Parler),
// .dialogue-validate (Valider cette réponse), .dialogue-close (Continuer),
// .qcm-next (Suivant). Pour les boutons secondaires/dots/img-arrow, on
// joue ui_tap. Le listener est en capture pour précéder les handlers
// internes (rapide même quand un click déclenche une nav).
document.addEventListener('click', (e) => {
  const tgt = e.target.closest(
    '.screen .btn, .talk-btn, .dialogue-validate, .dialogue-close, .qcm-next'
  );
  if (tgt) { sfx('ui_cta'); return; }
  const tap = e.target.closest(
    '.dialogue-dot, .img-arrow, .qcm-choice, .dialogue-choice, .topbar a, .topbar button'
  );
  if (tap) sfx('ui_tap');
}, true);

// Synchronisation du style du tracé entre éditeur et player.
// Appelé au chargement d'un module : pose les vars CSS --stroke-w,
// --stroke-opacity, --glow-r, --glow-a sur :root pour que .observation-skel
// et .quest-skel les utilisent.
function applyTraceStyle(ts) {
  if (!ts || typeof ts !== 'object') return;
  const root = document.documentElement;
  if (typeof ts.stroke === 'number') {
    root.style.setProperty('--stroke-w', String(ts.stroke));
  }
  if (typeof ts.opacity === 'number') {
    root.style.setProperty('--stroke-opacity', String(ts.opacity));
  }
  if (typeof ts.glow === 'number') {
    root.style.setProperty('--glow-r', `${(ts.glow * 18).toFixed(1)}px`);
    root.style.setProperty('--glow-a', (ts.glow * 0.95).toFixed(3));
  }
}

function showLevelMenu() {
  setLevelPill('Préparation');
  blurStage(true);
  const nQ = (game.scene.level1_questions || []).length;
  const nQuests = (game.scene.quests || []).length;
  setScreen(`
    <div class="eyebrow">✦ École de la maison ✦</div>
    <h2>${escapeHtml(game.scene.name)}</h2>
    <hr class="rule">
    <p>Bienvenue dans votre formation interactive.</p>
    <p class="big" style="margin-top:14px;"><strong>Niveau 1 — Observation</strong></p>
    <p style="margin-top:2px;">${nQ} questions disponibles · ${LEVEL1_TIMER_SECONDS}s d'observation · ${LEVEL1_QUESTION_COUNT} tirées au hasard.</p>
    <p class="big" style="margin-top:14px;"><strong>Niveau 2 — Approche commerciale</strong></p>
    <p style="margin-top:2px;">${nQuests} mini-quête${nQuests > 1 ? 's' : ''} à compléter.</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:22px;flex-wrap:wrap;">
      <button class="btn" id="start-1" ${nQ < 2 ? 'disabled' : ''}>Niveau 1 →</button>
      <button class="btn secondary" id="start-2" ${nQuests < 1 ? 'disabled' : ''}>Niveau 2 →</button>
    </div>
  `);
  $('start-1')?.addEventListener('click', startLevel1);
  $('start-2')?.addEventListener('click', startLevel2);
}

// ============================ LEVEL 1 ============================

function startLevel1() {
  setLevelPill('Niveau 1 · Observation');
  // Brief screen
  setScreen(`
    <div class="eyebrow">✦ Acte I ✦</div>
    <h2>Observation</h2>
    <hr class="rule">
    <p>Survolez les personnages pour les identifier, cliquez pour zoomer.</p>
    <p>Mémorisez : qui est présent, comment ils sont placés, ce qu'ils font. Vous serez interrogé ensuite.</p>
    <button class="btn" id="go-observe">Commencer l'observation</button>
  `);
  $('go-observe').addEventListener('click', runObservationPhase);
}

// ----- Phase observation interactive : navigation hover + clic comme l'éditeur -----
let _observationTickHandle = null;

function runObservationPhase() {
  blurStage(false);
  hideScreen();

  // Charge les contours skel + zones cliquables (comme dans l'éditeur).
  renderObservationLayer();

  // Compteur 20s indicatif — bascule auto vers le QCM à 0s (plus de CTA
  // pour skipper, l'observation est forcée pour ses 20 secondes).
  let secs = LEVEL1_TIMER_SECONDS;
  const counter = $('quest-counter');
  counter.classList.add('shown');

  function tick() {
    if (secs > 0) {
      counter.textContent = `Observation · ${secs}s`;
      secs--;
    } else {
      // Temps écoulé → bascule automatique aux questions, même si l'utilisateur
      // est zoomé sur un perso (image B). endObservation s'occupe de fermer
      // l'overlay et de reset le zoom.
      counter.textContent = `Temps écoulé…`;
      endObservation();
    }
  }
  tick();
  _observationTickHandle = setInterval(tick, 1000);
}

function endObservation() {
  if (_observationTickHandle) { clearInterval(_observationTickHandle); _observationTickHandle = null; }
  $('quest-counter').classList.remove('shown');
  // Cache le hint "Glissez pour explorer" s'il était encore affiché.
  hideObsSwipeHint();
  // Au cas où une ancienne version aurait laissé traîner le CTA dans le DOM,
  // on le retire défensivement.
  const cta = document.getElementById('observation-cta');
  if (cta) cta.remove();
  // Si un overlay (image B / zoom) est ouvert, on le ferme avant de basculer
  // aux questions. resetZoomToHome remet le master à sa position d'origine.
  const overlay = $('quest-overlay');
  if (overlay.classList.contains('shown')) {
    overlay.classList.remove('shown');
    overlay.onclick = null;
    $('quest-img').onclick = null;
  }
  // Reset zoom (au cas où un applyZoomToBox était en cours).
  if (typeof resetZoomToHome === 'function') {
    try { resetZoomToHome(); } catch {}
  }
  // Retire les contours et hit-zones du master + scroll listener.
  $('stage-wrap').removeEventListener('scroll', updateObservationByScroll);
  _observationSortedBoxes = [];
  _observationSkelMap = new Map();
  $('quest-layer').innerHTML = '';
  blurStage(true);
  startQCM();
}

// État partagé pour la mise en surbrillance par scroll mobile (niveau 1).
let _observationSortedBoxes = [];
let _observationSkelMap = new Map();

async function renderObservationLayer() {
  const layer = $('quest-layer');
  layer.innerHTML = '';
  const boxes = game.scene.boxes || [];
  _observationSkelMap = new Map();
  // Tri gauche → droite par CENTRE des cadres. Si on triait par bord gauche
  // (box.x), un cadre large dont le bord gauche commence un peu avant un
  // cadre étroit serait classé avant alors que son centre visuel est plus
  // à droite — donnant un ordre de surbrillance contre-intuitif quand les
  // sujets sont proches. Le centre (x + w/2) est l'ancre visuelle correcte.
  _observationSortedBoxes = [...boxes].sort((a, b) => {
    const ca = (a.x || 0) + (a.w || 0) / 2;
    const cb = (b.x || 0) + (b.w || 0) / 2;
    return ca - cb;
  });

  for (const box of boxes) {
    // Skel SVG (contour blanc, opaque seulement quand actif)
    try {
      const t = await fetch(`scenes/${sceneId}/lineart-svg/box-${box.id}-skel.svg`).then(r => r.text());
      const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
      const g = doc.querySelector('g');
      if (g) {
        const paths = g.querySelectorAll('path');
        if (paths.length > 1) {
          const merged = [...paths].map(p => p.getAttribute('d') || '').join(' ');
          while (g.firstChild) g.removeChild(g.firstChild);
          const onePath = document.createElementNS(SVG_NS, 'path');
          onePath.setAttribute('d', merged);
          g.appendChild(onePath);
        }
        const imp = g.cloneNode(true);
        imp.setAttribute('class', 'observation-skel');
        layer.appendChild(imp);
        _observationSkelMap.set(String(box.id), imp);
      }
    } catch {}

    // Zone cliquable (transparente)
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'observation-hit');
    rect.setAttribute('x', box.x);
    rect.setAttribute('y', box.y);
    rect.setAttribute('width', box.w);
    rect.setAttribute('height', box.h);
    const skel = _observationSkelMap.get(String(box.id));
    // Hover desktop : allumage individuel par survol.
    rect.addEventListener('mouseenter', () => {
      if (!isMobilePortrait()) skel?.classList.add('active');
    });
    rect.addEventListener('mouseleave', () => {
      if (!isMobilePortrait()) skel?.classList.remove('active');
    });
    rect.addEventListener('click', () => openObservationZoom(box));
    layer.appendChild(rect);
  }

  // Mobile portrait : on attache l'écoute du scroll pour activer le contour
  // de la portion courante. Désactivé en desktop (couvert par le hover).
  if (isMobilePortrait()) {
    const wrap = $('stage-wrap');
    wrap.removeEventListener('scroll', updateObservationByScroll);
    wrap.addEventListener('scroll', updateObservationByScroll, { passive: true });
    // Activation initiale (au tout début du scroll → premier cadre).
    requestAnimationFrame(updateObservationByScroll);
    // Affiche le hint "Glissez pour explorer →" + main animée. Fade-out
    // dès le premier événement de scroll (l'utilisateur a compris).
    showObsSwipeHint();
    const dismissHint = () => {
      hideObsSwipeHint();
      wrap.removeEventListener('scroll', dismissHint);
    };
    wrap.addEventListener('scroll', dismissHint, { passive: true, once: true });
  }
}

function showObsSwipeHint() {
  const hint = $('obs-swipe-hint');
  if (!hint) return;
  hint.classList.remove('fading');
  hint.classList.add('shown');
  // Safety : fade après 7s même sans scroll, pour ne pas polluer l'écran.
  clearTimeout(showObsSwipeHint._t);
  showObsSwipeHint._t = setTimeout(hideObsSwipeHint, 7000);
}
function hideObsSwipeHint() {
  const hint = $('obs-swipe-hint');
  if (!hint) return;
  clearTimeout(showObsSwipeHint._t);
  hint.classList.add('fading');
  // Retire complètement après la transition opacity (600ms).
  setTimeout(() => hint.classList.remove('shown', 'fading'), 700);
}

function isMobilePortrait() {
  return window.innerHeight > window.innerWidth;
}

// Divise la plage [0, maxScroll] en N portions égales (N = nb de cadres).
// La portion où se trouve scrollLeft détermine l'unique cadre allumé.
// Bien plus prévisible que « centre de l'écran » : chaque cadre a SA zone
// dédiée, même quand deux personnages sont visuellement proches.
function updateObservationByScroll() {
  if (!isMobilePortrait()) return;
  const sorted = _observationSortedBoxes;
  if (!sorted.length) return;
  const wrap = $('stage-wrap');
  const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
  let idx = 0;
  if (maxScroll > 0) {
    const t = wrap.scrollLeft / maxScroll;            // 0 .. 1
    idx = Math.min(sorted.length - 1, Math.floor(t * sorted.length));
  }
  for (let i = 0; i < sorted.length; i++) {
    const sk = _observationSkelMap.get(String(sorted[i].id));
    if (!sk) continue;
    sk.classList.toggle('active', i === idx);
  }
}

// Ouvre l'image B en plein écran SANS possibilité d'aller à l'image C.
// Un clic sur l'overlay ferme et ramène au master (pas de cycle B → C).
// Le zoom progressif (split pan + scale) reproduit l'effet de l'éditeur :
// la caméra arrive en 900 ms sur le perso, le scale finit en 1500 ms, et
// l'image B prend le relais via fade-in delayed à 1000 ms.
function openObservationZoom(box) {
  // 1. Préparer l'image B dans l'overlay (mais overlay encore invisible)
  const overlay = $('quest-overlay');
  const img = $('quest-img');
  $('quest-caption').style.display = 'none';
  $('quest-actions').innerHTML = '';   // pas de bouton "Parler"
  img.classList.remove('fade-out');
  img.src = `scenes/${sceneId}/exp3/imageB/box-${box.id}.jpg`;

  // 2. Lance le zoom cinématique sur le master
  applyZoomToBox(box);

  // 3. L'overlay devient .shown : son fade-in CSS est delayed 1000 ms, donc
  //    il apparaît pile quand le master finit son zoom + commence à fade-out.
  overlay.classList.add('shown');

  // 4. Un clic ferme : retour au master + reset zoom
  const close = () => {
    overlay.onclick = null;
    img.onclick = null;
    overlay.classList.remove('shown');
    resetZoomToHome();
  };
  overlay.onclick = close;
  img.onclick = close;
}

function startQCM() {
  const pool = game.scene.level1_questions || [];
  game.questions = shuffle(pool).slice(0, Math.min(LEVEL1_QUESTION_COUNT, pool.length));
  game.qIdx = 0;
  game.score = 0;
  showQuestion();
}

function showQuestion() {
  const q = game.questions[game.qIdx];
  if (!q) return showScore();
  // Shuffle choice order but track the correct one
  const idxs = q.choices.map((_, i) => i);
  const order = shuffle(idxs);
  const correctOriginalIdx = q.correct_index ?? 0;

  const choicesHtml = order.map((origIdx) => {
    return `<button class="qcm-choice" data-orig="${origIdx}">${escapeHtml(q.choices[origIdx])}</button>`;
  }).join('');

  setScreen(`
    <div class="qcm-card">
      <div class="qcm-progress">Question ${game.qIdx + 1} / ${game.questions.length}</div>
      <h3>${escapeHtml(q.text)}</h3>
      <div class="qcm-choices">${choicesHtml}</div>
      <div class="qcm-explain" id="qcm-explain"></div>
      <button class="qcm-next" id="qcm-next">Suivant →</button>
    </div>
  `);

  document.querySelectorAll('.qcm-choice').forEach(btn => {
    btn.addEventListener('click', () => {
      const picked = parseInt(btn.dataset.orig, 10);
      const good = picked === correctOriginalIdx;
      // Verrouille TOUS les boutons + cache ceux qui ne sont ni le choix
      // de l'utilisateur ni la bonne réponse. Cela libère de la hauteur
      // pour l'explication. La mauvaise réponse pickée garde sa croix.
      document.querySelectorAll('.qcm-choice').forEach(b => {
        b.disabled = true;
        const oi = parseInt(b.dataset.orig, 10);
        const isPicked = oi === picked;
        const isCorrect = oi === correctOriginalIdx;
        if (isCorrect) b.classList.add('was-correct');
        if (!isPicked && !isCorrect) {
          b.classList.add('hidden-after-pick');
        }
      });
      btn.classList.add('picked', good ? 'good' : 'bad');
      if (good) game.score++;
      sfx(good ? 'validate_good' : 'validate_bad');
      const exp = $('qcm-explain');
      exp.textContent = q.explanation || (good ? 'Bonne réponse.' : 'Réponse incorrecte.');
      exp.classList.add('shown');
      $('qcm-next').classList.add('shown');
    });
  });

  $('qcm-next').addEventListener('click', () => {
    game.qIdx++;
    showQuestion();
  });
}

function showScore() {
  game.level1Done = true;
  sfx('score_reveal');
  const total = game.questions.length;
  const pct = total ? Math.round(game.score * 100 / total) : 0;
  let verdict;
  if (pct >= 75) verdict = 'Excellente observation !';
  else if (pct >= 50) verdict = 'Bonne observation, mais quelques détails t\'ont échappé.';
  else verdict = 'Recommence — l\'observation est la première compétence du vendeur.';
  setScreen(`
    <div class="eyebrow">✦ Verdict ✦</div>
    <h2>Score : <em>${game.score} / ${total}</em></h2>
    <div class="score-pct">${pct}%</div>
    <hr class="rule">
    <p>${escapeHtml(verdict)}</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
      <button class="btn secondary" id="back-menu">← Menu</button>
      <button class="btn" id="goto-2">Niveau 2 →</button>
    </div>
  `);
  $('back-menu').addEventListener('click', showLevelMenu);
  $('goto-2').addEventListener('click', startLevel2);
}

// ============================ LEVEL 2 ============================

function startLevel2() {
  setLevelPill('Niveau 2 · Approche');
  game.questsDone = new Set();
  blurStage(true);
  // Hide the quest counter for now; show the brief
  $('quest-counter').classList.remove('shown');
  const total = (game.scene.quests || []).length;
  setScreen(`
    <div class="eyebrow">✦ Acte II ✦</div>
    <h2>Approche commerciale</h2>
    <hr class="rule">
    <p>Vous êtes vendeur·se dans cette boutique. Identifiez les opportunités et engagez la conversation avec les clients.</p>
    <p class="big" style="margin-top:14px;">Complétez les <strong>${total} mini-quête${total > 1 ? 's' : ''}</strong> en cliquant sur les groupes mis en valeur.</p>
    <p style="margin-top:14px;color:var(--faint);font-family:var(--sans);font-style:normal;font-size:14px;letter-spacing:1.5px;text-transform:uppercase;">Progression : 0 / ${total}</p>
    <button class="btn" id="go-quests">Commencer</button>
  `);
  $('go-quests').addEventListener('click', enterQuestMap);
}

function enterQuestMap() {
  hideScreen();
  blurStage(false);
  renderQuestLayer();
  updateQuestCounter();
  // Hint discret bas-centre : disparaît au premier clic sur un personnage.
  const hint = $('quest-hint');
  if (hint) {
    hint.textContent = 'Touchez un personnage doré pour engager la conversation.';
    hint.classList.add('shown');
  }
}

function updateQuestCounter() {
  const total = (game.scene.quests || []).length;
  const done = game.questsDone.size;
  const c = $('quest-counter');
  c.textContent = `Quêtes · ${done} / ${total}`;
  c.classList.add('shown');
  if (done >= total && total > 0) {
    setTimeout(showLevel2Score, 600);
  }
}

async function renderQuestLayer() {
  const layer = $('quest-layer');
  layer.innerHTML = '';
  const quests = game.scene.quests || [];
  const boxesById = Object.fromEntries((game.scene.boxes || []).map(b => [String(b.id), b]));

  for (const q of quests) {
    const box = boxesById[String(q.box_id)];
    if (!box) continue;
    const done = game.questsDone.has(q.id);

    // 1. The skel SVG path (golden shimmer)
    try {
      const t = await fetch(`scenes/${sceneId}/lineart-svg/box-${box.id}-skel.svg`).then(r => r.text());
      const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
      const g = doc.querySelector('g');
      if (g) {
        // Merge multiple paths into one for perf parity
        const paths = g.querySelectorAll('path');
        if (paths.length > 1) {
          const merged = [...paths].map(p => p.getAttribute('d') || '').join(' ');
          while (g.firstChild) g.removeChild(g.firstChild);
          const onePath = document.createElementNS(SVG_NS, 'path');
          onePath.setAttribute('d', merged);
          g.appendChild(onePath);
        }
        const imp = g.cloneNode(true);
        imp.setAttribute('class', 'quest-skel' + (done ? ' done' : ''));
        layer.appendChild(imp);
      }
    } catch {}

    // 2. Click hit-rect over the box
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'quest-hit' + (done ? ' done' : ''));
    rect.setAttribute('x', box.x);
    rect.setAttribute('y', box.y);
    rect.setAttribute('width', box.w);
    rect.setAttribute('height', box.h);
    if (!done) rect.addEventListener('click', () => openQuest(q));
    layer.appendChild(rect);
  }
}

function openQuest(q) {
  game.currentQuestId = q.id;
  game.currentQuestImage = 1;
  // Le hint bas-centre s'efface dès qu'on engage avec un personnage.
  $('quest-hint')?.classList.remove('shown');
  // Trouve le box lié à la quête pour appliquer le zoom cinématique sur le master.
  const box = (game.scene.boxes || []).find(b => String(b.id) === String(q.box_id));
  if (box) applyZoomToBox(box);
  showQuestImage();
  // L'overlay fade-in delayed 1000 ms (sync avec fin du zoom).
  $('quest-overlay').classList.add('shown');
}

function closeQuest() {
  $('quest-overlay').classList.remove('shown');
  game.currentQuestId = null;
  // Retour au master avec reset cinématique du zoom.
  resetZoomToHome();
}

function showQuestImage() {
  const q = (game.scene.quests || []).find(x => x.id === game.currentQuestId);
  if (!q) return;
  const img = $('quest-img');
  const cap = $('quest-caption');
  const actions = $('quest-actions');
  // L'image active est TOUJOURS image B (perso + bokeh + intro) ;
  // c'est seulement quand on tape "Parler" qu'on bascule sur image C
  // (zoom face caméra) qui sert de fond à la modale dialogue.
  const boxId = q.box_id;
  const primary = `scenes/${sceneId}/exp3/imageB/box-${boxId}.jpg`;
  const fallback = `scenes/${sceneId}/quests/${q.id}/image1.jpg`;
  img.classList.add('fade-out');
  setTimeout(() => {
    img.src = primary;
    img.onload = () => img.classList.remove('fade-out');
    img.onerror = () => {
      img.onerror = () => img.classList.remove('fade-out');
      img.src = fallback;
      img.onload = () => img.classList.remove('fade-out');
    };
  }, 180);

  // Caption + un seul bouton "Parler" (plus de flèche, plus de badge 1/2 :
  // l'image C devient le fond de la modale dialogue, pas un état séparé).
  cap.style.display = q.intro_text ? 'block' : 'none';
  cap.textContent = q.intro_text || '';
  actions.innerHTML = `<button class="talk-btn" id="talk-btn">Parler</button>`;
  $('talk-btn').addEventListener('click', openDialogue);
  img.onclick = openDialogue;
}

// Bascule l'image plein écran de l'overlay vers image C (zoom face caméra,
// sans flou). Utilisé au moment d'ouvrir la modale dialogue : l'image C
// devient le fond visible derrière la bottom-sheet velours.
function swapToImageC(q) {
  const img = $('quest-img');
  const cap = $('quest-caption');
  const actions = $('quest-actions');
  const boxId = q.box_id;
  const primary = `scenes/${sceneId}/exp3/imageC/box-${boxId}.jpg`;
  const fallback = `scenes/${sceneId}/quests/${q.id}/image2.jpg`;
  cap.style.display = 'none';
  actions.innerHTML = '';  // plus de bouton "Parler" pendant le dialogue
  img.classList.add('fade-out');
  setTimeout(() => {
    img.src = primary;
    img.onload = () => img.classList.remove('fade-out');
    img.onerror = () => {
      img.onerror = () => img.classList.remove('fade-out');
      img.src = fallback;
      img.onload = () => img.classList.remove('fade-out');
    };
  }, 180);
  img.onclick = null;  // on ne re-déclenche plus rien sur le tap image
}

// État local du dialogue v2 — l'index courant du carousel + l'ordre des
// choix mélangé (pour ne pas révéler la bonne réponse par position).
// _dialogueTouchDetach stocke les fns de cleanup des listeners touch.
let _dialogueChoiceIdx = 0;
let _dialogueOrder = [];
let _dialogueTouchDetach = null;

function openDialogue() {
  const q = (game.scene.quests || []).find(x => x.id === game.currentQuestId);
  if (!q) return;

  // 1. Bascule visuellement l'image B → image C (zoom face caméra, sans flou).
  swapToImageC(q);

  // 2. Header (eyebrow + titre)
  const eyebrowEl = $('dialogue-eyebrow');
  if (q.title) {
    eyebrowEl.textContent = `✦ ${q.title} ✦`;
    eyebrowEl.style.display = '';
  } else {
    eyebrowEl.style.display = 'none';
  }
  $('dialogue-title').textContent = 'Que dites-vous ?';

  // 3. Carousel translateX : on construit un track flex avec une "page"
  //    par choix mélangé. transform: translateX(-N * 100%) → pagination.
  _dialogueOrder = shuffle(q.dialogue_choices.map((_, i) => i));
  _dialogueChoiceIdx = 0;
  const track = $('dialogue-carousel-track');
  const dots = $('dialogue-dots');
  track.innerHTML = '';
  dots.innerHTML = '';

  _dialogueOrder.forEach((origIdx, viewIdx) => {
    const c = q.dialogue_choices[origIdx];
    const page = document.createElement('div');
    page.className = 'dialogue-carousel-page' + (viewIdx === 0 ? ' is-active' : '');
    page.dataset.view = viewIdx;
    page.dataset.orig = origIdx;
    const btn = document.createElement('button');
    btn.className = 'dialogue-choice';
    btn.textContent = `« ${c.text} »`;
    // Sur DESKTOP grid : le clic = sélectionne (highlight). Validation via
    // le bouton "Valider cette réponse" séparément.
    // Sur MOBILE swipe : le clic sur une carte non-active la centre ; sur
    // l'active rien (la validation est toujours via le bouton).
    btn.addEventListener('click', () => {
      if (viewIdx !== _dialogueChoiceIdx) setDialogueChoiceIdx(viewIdx);
    });
    page.appendChild(btn);
    track.appendChild(page);

    const dot = document.createElement('button');
    dot.className = 'dialogue-dot' + (viewIdx === 0 ? ' active' : '');
    dot.dataset.view = viewIdx;
    dot.addEventListener('click', () => setDialogueChoiceIdx(viewIdx));
    dots.appendChild(dot);
  });

  // 4. Swipe horizontal (touchstart / touchend) sur le wrap du carousel.
  const wrap = $('dialogue-carousel-wrap');
  let touchStartX = null;
  const onTouchStart = (e) => {
    touchStartX = e.touches[0].clientX;
    // Premier touch : coupe la tease anim pour ne pas combattre le swipe.
    $('dialogue-carousel-track').classList.remove('tease');
    $('dialogue-swipe-hint').classList.remove('tease');
  };
  const onTouchEnd = (e) => {
    if (touchStartX == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx < -40 && _dialogueChoiceIdx < _dialogueOrder.length - 1) {
      setDialogueChoiceIdx(_dialogueChoiceIdx + 1);
    } else if (dx > 40 && _dialogueChoiceIdx > 0) {
      setDialogueChoiceIdx(_dialogueChoiceIdx - 1);
    }
    touchStartX = null;
  };
  wrap.addEventListener('touchstart', onTouchStart, { passive: true });
  wrap.addEventListener('touchend', onTouchEnd, { passive: true });
  _dialogueTouchDetach = () => {
    wrap.removeEventListener('touchstart', onTouchStart);
    wrap.removeEventListener('touchend', onTouchEnd);
  };

  // 5. Bouton Valider : valide le choix actuellement affiché.
  const validateBtn = $('dialogue-validate');
  validateBtn.onclick = () => {
    const origIdx = _dialogueOrder[_dialogueChoiceIdx];
    onDialoguePick(q, origIdx);
  };

  // Position initiale du track + hint texte
  track.style.transform = 'translateX(0%)';
  updateDialogueHintText();

  // Reset feedback / close + montre les modules carousel/hint
  $('dialogue-feedback').classList.remove('shown', 'best');
  $('dialogue-feedback').innerHTML = '';
  $('dialogue-close').classList.remove('shown');
  $('dialogue-carousel-wrap').classList.remove('hidden');
  $('dialogue-dots').classList.remove('hidden');
  $('dialogue-hint-row').classList.remove('hidden');
  document.querySelector('.dialogue-body').classList.remove('feedback-mode');
  $('dialogue').classList.add('shown');

  // Pousse l'image C vers le bas pour qu'elle ne soit pas couverte par
  // la header card collée en haut.
  document.body.classList.add('in-dialogue');

  // Swipe tease : la 1re fois qu'on ouvre un dialogue dans cette session,
  // on joue une mini animation pour révéler le carousel swipeable. Si
  // l'utilisateur a déjà interagi (touch ou clic sur dot), on saute.
  const track2 = $('dialogue-carousel-track');
  const hint = $('dialogue-swipe-hint');
  // Reset des anim (au cas où on re-ouvre)
  track2.classList.remove('tease');
  hint.classList.remove('tease');
  // Re-trigger en forçant un reflow puis ré-application
  void track2.offsetWidth;
  track2.classList.add('tease');
  hint.classList.add('tease');
}

function setDialogueChoiceIdx(idx) {
  _dialogueChoiceIdx = idx;
  // Première interaction utilisateur : on coupe net la tease anim pour
  // ne pas combattre son swipe / clic de dot.
  $('dialogue-carousel-track').classList.remove('tease');
  $('dialogue-swipe-hint').classList.remove('tease');
  $('dialogue-carousel-track').style.transform = `translateX(-${idx * 100}%)`;
  document.querySelectorAll('.dialogue-carousel-page').forEach((p, i) =>
    p.classList.toggle('is-active', i === idx));
  document.querySelectorAll('.dialogue-dot').forEach((d, i) =>
    d.classList.toggle('active', i === idx));
  updateDialogueHintText();
}

function updateDialogueHintText() {
  const n = _dialogueOrder.length;
  if (!n) return;
  $('dialogue-hint-text').textContent = `${_dialogueChoiceIdx + 1} / ${n} · Glissez pour parcourir`;
}

// État du feedback : si on a fait un mauvais choix, on affiche d'abord
// "Votre choix" et le bouton "Voir la meilleure option →" doit révéler
// la 2e card avant de pouvoir fermer le dialogue. Le flag est posé par
// onDialoguePick et lu par le handler de dialogue-close.
let _dialogueBestPending = null;  // null ou { quote, explain }

function onDialoguePick(q, origIdx) {
  const c = q.dialogue_choices[origIdx];
  const isBest = !!c.is_best;
  sfx(isBest ? 'validate_good' : 'validate_bad');
  // Cache le carousel + dots + hint+valider, bascule le body en mode feedback
  $('dialogue-carousel-wrap').classList.add('hidden');
  $('dialogue-dots').classList.add('hidden');
  $('dialogue-hint-row').classList.add('hidden');
  document.querySelector('.dialogue-body').classList.add('feedback-mode');

  const fb = $('dialogue-feedback');
  fb.classList.toggle('best', isBest);

  const userExplain = c.explanation
    || (isBest ? 'Bon choix — vous établissez une vraie connexion.'
               : 'Pas le meilleur — la cliente reste sur la défensive.');

  // 1re card : "★ Meilleur choix" si bon, sinon "Votre choix".
  fb.innerHTML = renderFeedbackCard({
    leadClass: isBest ? 'best' : 'alt',
    leadText: isBest ? '★ Meilleur choix' : 'Votre choix',
    quote: c.text,
    explain: userExplain,
  });
  fb.classList.add('shown');

  // Si mauvais choix : on stocke la meilleure option pour pouvoir la
  // révéler au clic suivant, et on libelle le bouton "Voir la meilleure
  // option →" (au lieu de "Continuer").
  if (!isBest) {
    const best = (q.dialogue_choices || []).find(x => x.is_best);
    if (best) {
      _dialogueBestPending = {
        quote: best.text,
        explain: best.explanation
          || 'Cette formulation respecte le rythme d\'observation de la cliente sans s\'imposer.',
      };
      $('dialogue-close').textContent = 'Voir la meilleure option →';
    } else {
      _dialogueBestPending = null;
      $('dialogue-close').textContent = 'Continuer';
    }
  } else {
    _dialogueBestPending = null;
    $('dialogue-close').textContent = 'Continuer';
  }
  $('dialogue-close').classList.add('shown');
}

// Helper de rendu d'une card de feedback (badge + citation + filet + explication).
function renderFeedbackCard({ leadClass, leadText, quote, explain, secondary }) {
  return `<div class="feedback-card ${leadClass} ${secondary ? 'is-secondary' : ''}">` +
    `<span class="lead ${leadClass}">${escapeHtml(leadText)}</span>` +
    `<div class="quote">« ${escapeHtml(quote)} »</div>` +
    `<div class="rule"></div>` +
    `<div class="explain">${escapeHtml(explain)}</div>` +
  `</div>`;
}

$('dialogue-close').addEventListener('click', () => {
  // Si on était sur la card "Votre choix" et qu'une meilleure option est
  // en attente, on swap la card vers "★ Meilleure option" et on rebascule
  // le bouton en "Continuer". Le prochain clic ferme vraiment.
  if (_dialogueBestPending) {
    const fb = $('dialogue-feedback');
    fb.classList.add('best');
    fb.innerHTML = renderFeedbackCard({
      leadClass: 'best',
      leadText: '★ Meilleure option',
      quote: _dialogueBestPending.quote,
      explain: _dialogueBestPending.explain,
    });
    $('dialogue-close').textContent = 'Continuer';
    _dialogueBestPending = null;
    return;
  }
  // mark quest as done
  if (game.currentQuestId) game.questsDone.add(game.currentQuestId);
  $('dialogue').classList.remove('shown');
  document.body.classList.remove('in-dialogue');
  // Cleanup listeners + reset visibilité des modules pour le prochain dialogue
  if (typeof _dialogueTouchDetach === 'function') {
    _dialogueTouchDetach();
    _dialogueTouchDetach = null;
  }
  $('dialogue-carousel-track').classList.remove('tease');
  $('dialogue-swipe-hint').classList.remove('tease');
  $('dialogue-carousel-wrap').classList.remove('hidden');
  $('dialogue-dots').classList.remove('hidden');
  $('dialogue-hint-row').classList.remove('hidden');
  $('dialogue-feedback').classList.remove('shown', 'best');
  $('dialogue-close').classList.remove('shown');
  document.querySelector('.dialogue-body').classList.remove('feedback-mode');
  closeQuest();
  // re-render the map so the just-completed quest is greyed
  renderQuestLayer();
  updateQuestCounter();
});

function showLevel2Score() {
  $('quest-counter').classList.remove('shown');
  $('quest-hint')?.classList.remove('shown');
  blurStage(true);
  sfx('score_reveal');
  // Sur lien public : pas de retour à la Bibliothèque. On propose plutôt
  // « Rejouer » qui recharge la scène du début. Sur lien depuis la
  // bibliothèque : on garde le bouton Bibliothèque comme avant.
  const ctaPrimary = fromLibrary
    ? `<a class="btn" href="library.html">Bibliothèque</a>`
    : `<button class="btn" id="replay">Rejouer</button>`;
  setScreen(`
    <div class="eyebrow">✦ Rideau ✦</div>
    <div class="grand-title">Bravo&nbsp;!</div>
    <hr class="rule">
    <p>Vous avez complété les <strong>${game.questsDone.size}</strong> mini-quêtes de ce module.</p>
    <p>Continuez à pratiquer — chaque client mérite une approche personnalisée.</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap;">
      <button class="btn secondary" id="back-menu">← Menu</button>
      ${ctaPrimary}
    </div>
  `);
  $('back-menu')?.addEventListener('click', showLevelMenu);
  $('replay')?.addEventListener('click', () => window.location.reload());
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();
