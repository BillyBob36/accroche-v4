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
  // Welcome screen → choose level
  showLevelMenu();
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
    counter.textContent = secs > 0
      ? `Observation · ${secs}s`
      : `Observation libre`;
    if (secs > 0) secs--;
  }
  tick();
  _observationTickHandle = setInterval(tick, 1000);
}

function endObservation() {
  if (_observationTickHandle) { clearInterval(_observationTickHandle); _observationTickHandle = null; }
  $('quest-counter').classList.remove('shown');
  const cta = document.getElementById('observation-cta');
  if (cta) cta.style.display = 'none';
  // Retire les contours et hit-zones du master.
  $('quest-layer').innerHTML = '';
  blurStage(true);
  startQCM();
}

async function renderObservationLayer() {
  const layer = $('quest-layer');
  layer.innerHTML = '';
  const boxes = game.scene.boxes || [];
  const skelMap = new Map();

  for (const box of boxes) {
    // Skel SVG (contour blanc, comme dans l'éditeur, opaque seulement au hover)
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
        skelMap.set(String(box.id), imp);
      }
    } catch {}

    // Zone cliquable (transparente)
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'observation-hit');
    rect.setAttribute('x', box.x);
    rect.setAttribute('y', box.y);
    rect.setAttribute('width', box.w);
    rect.setAttribute('height', box.h);
    const skel = skelMap.get(String(box.id));
    rect.addEventListener('mouseenter', () => skel?.classList.add('active'));
    rect.addEventListener('mouseleave', () => skel?.classList.remove('active'));
    rect.addEventListener('click', () => openObservationZoom(box));
    layer.appendChild(rect);
  }
}

// Ouvre l'image B en plein écran SANS possibilité d'aller à l'image C.
// Un clic sur l'overlay ferme et ramène au master (pas de cycle B → C).
function openObservationZoom(box) {
  const overlay = $('quest-overlay');
  const img = $('quest-img');
  $('quest-caption').style.display = 'none';
  $('quest-actions').innerHTML = '';   // pas de bouton "Parler"
  img.classList.add('fade-out');
  setTimeout(() => {
    // Source principale = imageB du cadre, fallback sur ancien chemin pour rétrocompat
    const primary = `scenes/${sceneId}/exp3/imageB/box-${box.id}.jpg`;
    img.src = primary;
    img.onload = () => img.classList.remove('fade-out');
    img.onerror = () => img.classList.remove('fade-out');
  }, 180);
  overlay.classList.add('shown');
  // Un clic n'importe où sur l'overlay le ferme (et pas de bascule B↔C).
  overlay.onclick = (e) => {
    // Ignore les clics sur l'image elle-même pour éviter les fermetures accidentelles
    // au moment du chargement ; sinon ferme.
    overlay.onclick = null;
    overlay.classList.remove('shown');
  };
  // L'image est aussi cliquable
  img.onclick = () => {
    overlay.onclick = null;
    overlay.classList.remove('shown');
  };
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
  showQuestImage();
  $('quest-overlay').classList.add('shown');
}

function closeQuest() {
  $('quest-overlay').classList.remove('shown');
  game.currentQuestId = null;
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
