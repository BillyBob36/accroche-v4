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
  $('screen-panel').innerHTML = html;
  $('screen').classList.add('shown');
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
  // Applique le style du tracé sauvegardé dans le module (cf. l'éditeur).
  // Sans ça, les contours du player ont un style fixe (3 px, opacité 0.92,
  // pas de glow) qui peut différer de ce qu'a réglé l'auteur dans l'éditeur.
  applyTraceStyle(game.scene.trace_style);
  // Welcome screen → choose level
  showLevelMenu();
}

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
    <h2>${game.scene.name}</h2>
    <p style="margin-top:14px;">Bienvenue. Cette formation comporte deux niveaux :</p>
    <p class="big" style="margin-top:18px;"><strong>Niveau 1 — Observation</strong></p>
    <p style="margin-top:4px;">${nQ} questions disponibles · ${LEVEL1_TIMER_SECONDS}s d'observation · ${LEVEL1_QUESTION_COUNT} questions tirées au hasard.</p>
    <p class="big" style="margin-top:18px;"><strong>Niveau 2 — Approche commerciale</strong></p>
    <p style="margin-top:4px;">${nQuests} mini-quête${nQuests > 1 ? 's' : ''} à compléter.</p>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:24px;flex-wrap:wrap;">
      <button class="btn" id="start-1" ${nQ < 2 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>Niveau 1 →</button>
      <button class="btn secondary" id="start-2" ${nQuests < 1 ? 'disabled style="opacity:0.4;cursor:not-allowed;"' : ''}>Niveau 2 →</button>
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
    <h2>Niveau 1 — Observation</h2>
    <p style="margin-top:14px;">Vous arrivez sur le pas de la porte d'une boutique. Survolez les personnages pour les identifier, cliquez pour zoomer.</p>
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

  // Compteur 20s indicatif + bouton "Continuer aux questions" pour skipper.
  let secs = LEVEL1_TIMER_SECONDS;
  const counter = $('quest-counter');
  counter.classList.add('shown');

  // Bouton "Continuer" en bas-centre — toujours dispo (pas obligé d'attendre)
  let cta = document.getElementById('observation-cta');
  if (!cta) {
    cta = document.createElement('button');
    cta.id = 'observation-cta';
    cta.className = 'talk-btn';  // réutilise le style "Parler" : pill doré
    cta.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:24;';
    cta.textContent = 'Continuer aux questions →';
    cta.addEventListener('click', endObservation);
    document.body.appendChild(cta);
  }
  cta.style.display = 'inline-block';

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
  const cta = document.getElementById('observation-cta');
  if (cta) cta.style.display = 'none';
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
  // Tri gauche → droite : indispensable pour l'algorithme « N portions égales ».
  _observationSortedBoxes = [...boxes].sort((a, b) => (a.x || 0) - (b.x || 0));

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
  }
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
      // Lock all
      document.querySelectorAll('.qcm-choice').forEach(b => {
        b.disabled = true;
        const oi = parseInt(b.dataset.orig, 10);
        if (oi === correctOriginalIdx) b.classList.add('was-correct');
      });
      btn.classList.add('picked', good ? 'good' : 'bad');
      if (good) game.score++;
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
  const total = game.questions.length;
  const pct = total ? Math.round(game.score * 100 / total) : 0;
  let verdict;
  if (pct >= 75) verdict = 'Excellente observation !';
  else if (pct >= 50) verdict = 'Bonne observation, mais quelques détails t\'ont échappé.';
  else verdict = 'Recommence — l\'observation est la première compétence du vendeur.';
  setScreen(`
    <h2>Score : ${game.score} / ${total}</h2>
    <p style="font-size:32px;color:var(--accent);font-weight:300;margin:8px 0;">${pct}%</p>
    <p>${verdict}</p>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
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
    <h2>Niveau 2 — Approche commerciale</h2>
    <p style="margin-top:14px;">Vous êtes vendeur·se dans cette boutique. Identifiez les opportunités et engagez la conversation avec les clients.</p>
    <p class="big" style="margin-top:18px;">Complétez les <strong>${total} mini-quête${total > 1 ? 's' : ''}</strong> en cliquant sur les groupes mis en valeur.</p>
    <p style="margin-top:14px;color:var(--dim);font-size:12px;">Progression : 0 / ${total}</p>
    <button class="btn" id="go-quests">Commencer</button>
  `);
  $('go-quests').addEventListener('click', enterQuestMap);
}

function enterQuestMap() {
  hideScreen();
  blurStage(false);
  renderQuestLayer();
  updateQuestCounter();
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
  const idx = game.currentQuestImage;
  const img = $('quest-img');
  const cap = $('quest-caption');
  const actions = $('quest-actions');
  // Source d'image: les images B/C du cadre lié sont la SOURCE PRINCIPALE
  // (image 1 = imageB perso+bokeh, image 2 = imageC face caméra). On garde un
  // fallback sur l'ancien dossier quests/<qid>/imageN.jpg pour les modules
  // sauvegardés AVANT cette refonte.
  const boxId = q.box_id;
  const primary = idx === 1
    ? `scenes/${sceneId}/exp3/imageB/box-${boxId}.jpg`
    : `scenes/${sceneId}/exp3/imageC/box-${boxId}.jpg`;
  const fallback = `scenes/${sceneId}/quests/${q.id}/image${idx}.jpg`;
  // Fade swap
  img.classList.add('fade-out');
  setTimeout(() => {
    img.src = primary;
    img.onload = () => img.classList.remove('fade-out');
    img.onerror = () => {
      // Fallback : essaye l'ancien chemin (rétrocompat des modules pré-refonte)
      img.onerror = () => img.classList.remove('fade-out');
      img.src = fallback;
      img.onload = () => img.classList.remove('fade-out');
    };
  }, 180);

  if (idx === 1) {
    cap.style.display = q.intro_text ? 'block' : 'none';
    cap.textContent = q.intro_text || '';
    actions.innerHTML = `
      <span class="badge">1 / 2</span>
      <button class="img-arrow" id="next-img" title="Image suivante">→</button>
      <button class="talk-btn" id="talk-btn">Parler</button>
    `;
    $('next-img').addEventListener('click', () => { game.currentQuestImage = 2; showQuestImage(); });
    $('talk-btn').addEventListener('click', openDialogue);
    img.onclick = () => { game.currentQuestImage = 2; showQuestImage(); };
  } else {
    cap.style.display = 'none';
    actions.innerHTML = `
      <button class="img-arrow" id="prev-img" title="Image précédente">←</button>
      <span class="badge">2 / 2</span>
      <button class="talk-btn" id="talk-btn">Parler</button>
    `;
    $('prev-img').addEventListener('click', () => { game.currentQuestImage = 1; showQuestImage(); });
    $('talk-btn').addEventListener('click', openDialogue);
    img.onclick = openDialogue;
  }
}

function openDialogue() {
  const q = (game.scene.quests || []).find(x => x.id === game.currentQuestId);
  if (!q) return;
  $('dialogue-title').textContent = q.title ? `${q.title} — Que dites-vous ?` : 'Que dites-vous ?';
  // Shuffle dialogue choices but track which one was the best
  const order = shuffle(q.dialogue_choices.map((_, i) => i));
  const box = $('dialogue-choices');
  box.innerHTML = '';
  order.forEach(origIdx => {
    const c = q.dialogue_choices[origIdx];
    const btn = document.createElement('button');
    btn.className = 'dialogue-choice';
    btn.dataset.orig = origIdx;
    btn.textContent = c.text;
    btn.addEventListener('click', () => onDialoguePick(q, origIdx, btn));
    box.appendChild(btn);
  });
  $('dialogue-feedback').classList.remove('shown');
  $('dialogue-feedback').textContent = '';
  $('dialogue-close').classList.remove('shown');
  $('dialogue').classList.add('shown');
}

function onDialoguePick(q, origIdx, btn) {
  const c = q.dialogue_choices[origIdx];
  const isBest = !!c.is_best;
  document.querySelectorAll('.dialogue-choice').forEach(b => b.disabled = true);
  btn.classList.add('picked', isBest ? 'best' : 'notbest');
  // Show feedback
  const fb = $('dialogue-feedback');
  let text = c.explanation || '';
  if (!text) text = isBest
    ? 'Bon choix — vous établissez une vraie connexion.'
    : 'Pas le meilleur — la cliente reste sur la défensive.';
  fb.innerHTML = `<strong style="color:${isBest ? 'var(--good)' : 'var(--dim)'};">${isBest ? '★ Meilleur choix' : 'Choix possible'}</strong><br>${escapeHtml(text)}`;
  fb.classList.add('shown');
  $('dialogue-close').classList.add('shown');
}

$('dialogue-close').addEventListener('click', () => {
  // mark quest as done
  if (game.currentQuestId) game.questsDone.add(game.currentQuestId);
  $('dialogue').classList.remove('shown');
  closeQuest();
  // re-render the map so the just-completed quest is greyed
  renderQuestLayer();
  updateQuestCounter();
});

function showLevel2Score() {
  $('quest-counter').classList.remove('shown');
  blurStage(true);
  setScreen(`
    <h2>Bravo !</h2>
    <p style="margin-top:14px;">Vous avez complété les <strong>${game.questsDone.size}</strong> mini-quêtes de ce module.</p>
    <p>Continuez à pratiquer — chaque client mérite une approche personnalisée.</p>
    <div style="display:flex;gap:8px;justify-content:center;margin-top:18px;flex-wrap:wrap;">
      <button class="btn secondary" id="back-menu">← Menu</button>
      <a class="btn" href="library.html">Bibliothèque</a>
    </div>
  `);
  $('back-menu')?.addEventListener('click', showLevelMenu);
}

// ---------- utils ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

init();
