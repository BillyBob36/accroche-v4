'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MASTER_W = 2560, MASTER_H = 1440;
// All supported aspect-ratio presets. 'free' means no ratio lock.
const ASPECTS = {
  '1:1':  [1, 1],
  '5:4':  [5, 4],
  '4:3':  [4, 3],
  '3:2':  [3, 2],
  '16:9': [16, 9],
  '21:9': [21, 9],
  '4:5':  [4, 5],
  '3:4':  [3, 4],
  '2:3':  [2, 3],
  '9:16': [9, 16],
  '9:21': [9, 21],
};
const HANDLE_SIZE = 28;  // resize-handle side, in master coords
const MIN_BOX = 120;     // min box dimension, in master coords
// gpt-image-2 caps aspect ratio at 3:1. Reject free-form boxes that would exceed
// this so we never produce a generation that the API would reject.
const MAX_RATIO = 3.0;

const DEFAULT_PROMPT = "Hero photograph for a luxury fashion editorial. Inside a high-end designer handbag boutique: warm marble floors, soft golden display lighting, glass shelves with handbags arranged sparsely. Five well-dressed customers visible: a woman in a beige trench coat examining a bag on the left, a stylish couple in dark coats near the center looking at a display, a young woman in a red dress holding a handbag near the back-right, and a man in a tailored navy suit standing near the entrance on the right. Wide landscape composition, eye-level, shallow depth of field, golden-hour ambient light through tall windows, photorealistic, magazine-quality. All customers fully visible, head to mid-thigh at minimum, well-spaced apart. No watermark, no text, no logos, no trademarks.";

const state = {
  phase: 'home',
  boxes: [],
  selectedBoxId: null,
  activeShowcaseId: null,
  drawingAspect: null,
};
const skelMap = new Map();
let dragState = null;
let drawState = null;

// ----- Mobile mode state -----
const mobile = { active: false, scrollX: 0, maxScroll: 0 };

const $ = id => document.getElementById(id);

function setPhase(p) {
  state.phase = p;
  // Re-enable CSS-defined transitions for the next phase change.
  // setMobileScroll disables them inline for instant scroll; we restore here.
  $('stage').style.transition = '';
  $('zoom-inner').style.transition = '';
  document.body.classList.remove(
    'state-home', 'state-editor', 'state-imageB', 'state-imageC', 'state-character'
  );
  document.body.classList.add(`state-${p}`);
}

function masterPoint(evt) {
  const svg = $('editor-layer');
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function statusText() {
  if (!state.boxes.length) return 'aucun cadre — ouvre la roue puis "Éditer les cadres"';
  if (mobile.active) return `${state.boxes.length} cadre${state.boxes.length > 1 ? 's' : ''} — fais glisser pour révéler`;
  return `${state.boxes.length} cadre${state.boxes.length > 1 ? 's' : ''} — survole pour voir le contour`;
}

// ============ MOBILE LAYOUT ============================================
function detectMobile() {
  // Treat any portrait viewport as mobile mode.
  return window.innerHeight > window.innerWidth;
}

function getStageNaturalDims() {
  // Read what the browser actually renders, not what we computed from
  // window.innerHeight — on mobile those differ (100vh = LARGE viewport,
  // window.innerHeight = visible viewport with address bar shown).
  const stage = $('stage');
  return { w: stage.offsetWidth, h: stage.offsetHeight };
}

function updateMobileMode() {
  const next = detectMobile();
  const wasActive = mobile.active;
  mobile.active = next;
  document.body.classList.toggle('mode-mobile', mobile.active);

  if (mobile.active) {
    const dims = getStageNaturalDims();
    mobile.maxScroll = Math.max(0, dims.w - window.innerWidth);
    mobile.scrollX = Math.max(0, Math.min(mobile.maxScroll, mobile.scrollX));
  } else {
    mobile.scrollX = 0;
  }

  updateStageTransform();
  if (mobile.active) {
    updateSliderThumb();
    if (state.phase === 'home') updateActiveBoxesByScroll();
  } else if (wasActive) {
    clearAutoReveal();
  }
  $('status').textContent = statusText();
}
window.addEventListener('resize', updateMobileMode);
window.addEventListener('orientationchange', updateMobileMode);

function updateStageTransform() {
  // Only used in home state for scroll/desktop-default. Zoom-target panning is
  // set inline by applyZoom (and the matching scale on zoom-inner).
  const stage = $('stage');
  if (mobile.active && state.phase === 'home') {
    stage.style.transform = `translateX(${-mobile.scrollX}px)`;
  } else if (!mobile.active && state.phase === 'home') {
    stage.style.transform = '';
  }
}

function setMobileScroll(x) {
  if (!mobile.active) return;
  mobile.scrollX = Math.max(0, Math.min(mobile.maxScroll, x));
  const stage = $('stage');
  // Disable transition inline so the transform tracks the finger 1:1.
  stage.style.transition = 'none';
  stage.style.transform = `translateX(${-mobile.scrollX}px)`;
  updateSliderThumb();
  if (state.phase === 'home') updateActiveBoxesByScroll();
}

function updateSliderThumb() {
  if (!mobile.active) return;
  const slider = $('m-slider');
  const thumb = $('m-slider-thumb');
  if (!slider || !thumb) return;
  const trackW = slider.clientWidth - 64;  // 32px inset on each side
  const t = mobile.maxScroll > 0 ? mobile.scrollX / mobile.maxScroll : 0;
  thumb.style.left = `${32 + t * trackW - thumb.offsetWidth / 2}px`;
}

function updateActiveBoxesByScroll() {
  if (!mobile.active) return;
  const dims = getStageNaturalDims();
  const masterPerPx = MASTER_W / dims.w;
  const vpCenterStagePx = mobile.scrollX + window.innerWidth / 2;
  const vpCenterMaster = vpCenterStagePx * masterPerPx;
  const tolMaster = window.innerWidth * 0.25 * masterPerPx;
  for (const b of state.boxes) {
    const id = String(b.id);
    const skel = skelMap.get(id);
    if (!skel) continue;
    const bcx = b.x + b.w / 2;
    skel.classList.toggle('active', Math.abs(bcx - vpCenterMaster) < tolMaster);
  }
}

function clearAutoReveal() {
  for (const skel of skelMap.values()) skel.classList.remove('active');
}

// Touch swipe — listen at document level so swiping anywhere on the image works,
// and so we can mark the gesture as "swiped" before the synthetic click on a
// hit-rect fires (which would otherwise open an image during a horizontal pan).
let _touchSwiped = false;
{
  let touchStart = null;
  const SWIPE_THRESHOLD = 8;  // px; below this we treat the gesture as a tap

  document.addEventListener('touchstart', e => {
    if (!mobile.active || state.phase !== 'home') return;
    if (e.touches.length !== 1) return;
    // Don't hijack touches that started on the slider — it has its own drag logic
    if (e.target.closest('#m-slider')) return;
    touchStart = { x: e.touches[0].clientX, scrollX: mobile.scrollX };
    _touchSwiped = false;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!touchStart) return;
    const dx = touchStart.x - e.touches[0].clientX;
    if (Math.abs(dx) > SWIPE_THRESHOLD) _touchSwiped = true;
    if (_touchSwiped) {
      e.preventDefault();
      setMobileScroll(touchStart.scrollX + dx);
    }
  }, { passive: false });

  function endTouch() {
    touchStart = null;
    // Keep _touchSwiped true through the synthetic click that fires immediately
    // after touchend, then clear shortly after.
    setTimeout(() => { _touchSwiped = false; }, 60);
  }
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);
}

// Slider drag (pointer events handle mouse + touch)
{
  const slider = $('m-slider');
  const thumb = $('m-slider-thumb');
  let dragging = false;

  function knobX(clientX) {
    const rect = slider.getBoundingClientRect();
    const trackStart = rect.left + 32;
    const trackEnd = rect.right - 32;
    const x = Math.max(trackStart, Math.min(trackEnd, clientX));
    return (x - trackStart) / (trackEnd - trackStart);
  }

  slider.addEventListener('pointerdown', e => {
    if (!mobile.active) return;
    e.preventDefault();
    dragging = true;
    slider.classList.add('dragging');
    slider.setPointerCapture(e.pointerId);
    const t = knobX(e.clientX);
    setMobileScroll(t * mobile.maxScroll);
  });
  slider.addEventListener('pointermove', e => {
    if (!dragging) return;
    const t = knobX(e.clientX);
    setMobileScroll(t * mobile.maxScroll);
  });
  function end(e) {
    if (!dragging) return;
    dragging = false;
    slider.classList.remove('dragging');
    try { slider.releasePointerCapture(e.pointerId); } catch {}
  }
  slider.addEventListener('pointerup', end);
  slider.addEventListener('pointercancel', end);
}

// Showcase img cache: created lazily, kept across showcase entries.
const showImgCache = new Map();   // key `${id}-${type}` -> <img>
let _sceneStamp = '';             // cache-busting query string used in this scene load

function showImgUrl(id, type, stamp) {
  // Try .jpg first; the server serves whichever format actually exists.
  return `exp3/image${type.toUpperCase()}/box-${id}.jpg${stamp}`;
}

function preloadImage(href) {
  // Prefetch into HTTP cache without creating an <img> element. The browser
  // downloads the bytes but doesn't decode/composite them — no GPU layer or
  // memory cost for unrendered images. When we later create an <img> with the
  // same URL, it's served from the cache (instant).
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'image';
  link.href = href;
  link.fetchPriority = 'low';
  document.head.appendChild(link);
}

// ============ SCENE LOADING (home) =====================================
async function loadScene() {
  const stamp = `?t=${Date.now()}`;
  _sceneStamp = stamp;
  $('master').src = `master.jpg${stamp}`;
  const contour = $('contour-layer');
  const hit = $('hit-layer');
  const showcase = $('showcase');
  contour.innerHTML = '';
  hit.innerHTML = '';
  showcase.innerHTML = '';
  skelMap.clear();
  showImgCache.clear();

  let boxes = [];
  try {
    const r = await fetch('/api/boxes', { cache: 'no-store' });
    const j = await r.json();
    boxes = j.boxes || [];
  } catch {}
  state.boxes = boxes;

  for (const b of boxes) {
    const id = String(b.id);

    try {
      const t = await (await fetch(`lineart-svg/box-${id}-skel.svg${stamp}`)).text();
      const doc = new DOMParser().parseFromString(t, 'image/svg+xml');
      const g = doc.querySelector('g');
      if (g) {
        // Merge all child <path> d-attributes into a single <path>. Each
        // sub-path keeps its own M/moveto so they don't visually connect; the
        // browser renders them identically with far fewer DOM nodes.
        const paths = g.querySelectorAll('path');
        if (paths.length > 1) {
          const merged = [...paths].map(p => p.getAttribute('d') || '').join(' ');
          while (g.firstChild) g.removeChild(g.firstChild);
          const onePath = document.createElementNS(SVG_NS, 'path');
          onePath.setAttribute('d', merged);
          g.appendChild(onePath);
        }
        const imp = g.cloneNode(true);
        imp.classList.add('skel-group');
        contour.appendChild(imp);
        skelMap.set(id, imp);
      }
    } catch {}

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'hit-rect');
    rect.setAttribute('x', b.x);
    rect.setAttribute('y', b.y);
    rect.setAttribute('width', b.w);
    rect.setAttribute('height', b.h);
    rect.dataset.id = id;
    rect.addEventListener('mouseenter', () => {
      if (state.phase !== 'home') return;
      skelMap.get(id)?.classList.add('active');
      $('status').textContent = `survol : ${b.subject || 'cadre ' + id}`;
    });
    rect.addEventListener('mouseleave', () => {
      skelMap.get(id)?.classList.remove('active');
      if (state.phase === 'home') $('status').textContent = statusText();
    });
    rect.addEventListener('click', e => {
      if (state.phase !== 'home') return;
      if (mobile.active && _touchSwiped) return;
      if (mobile.active && !skelMap.get(id)?.classList.contains('active')) return;
      e.stopPropagation();
      enterShowcase('imageB', id);
    });
    hit.appendChild(rect);

    // Preload showcase images via <link rel="preload"> rather than creating
    // <img> elements upfront. They fetch into the HTTP cache without consuming
    // GPU/decode resources, and we materialize the <img> on demand.
    preloadImage(showImgUrl(id, 'b', stamp));
    preloadImage(showImgUrl(id, 'c', stamp));
  }

  $('status').textContent = statusText();
  if (mobile.active) updateActiveBoxesByScroll();
}

function getOrCreateShowImg(id, type, stamp) {
  const key = `${id}-${type}`;
  if (showImgCache.has(key)) return showImgCache.get(key);
  const img = document.createElement('img');
  img.className = 'show-img';
  img.dataset.id = id;
  img.dataset.type = type;
  img.decoding = 'async';
  img.alt = '';
  img.src = showImgUrl(id, type, stamp);
  showImgCache.set(key, img);
  $('showcase').appendChild(img);
  return img;
}

function enterShowcase(phase, id) {
  // Image B/C is preloaded in the DOM but kept invisible. We decide WHEN it
  // fades in based on whether we're zooming in (delay so the destination
  // doesn't leak through the empty black borders during the camera pan) or
  // crossfading B↔C (immediate).
  const showcase = $('showcase');
  const t = phase === 'imageB' ? 'b' : 'c';
  const fromHome = phase === 'imageB' && state.phase === 'home';

  // Reset transitions on any currently-mounted show-img and remove .shown.
  // Avoids the 1000ms-delayed B→fade-out when crossfading to C.
  showcase.querySelectorAll('.show-img').forEach(i => {
    i.style.transition = 'opacity 350ms ease 0ms';
    i.classList.remove('shown');
  });
  // Lazily create the <img> only when we actually need it. The bytes are
  // already in the HTTP cache thanks to <link rel="preload">.
  const img = getOrCreateShowImg(id, t, _sceneStamp);
  if (img) {
    if (fromHome) {
      // Sync with the master fade-out: same 500ms duration, same 1000ms delay.
      img.style.transition = 'opacity 500ms ease 1000ms';
    }
    img.classList.add('shown');
    if (mobile.active) centerShowcase(img);
  }

  if (fromHome) {
    const box = state.boxes.find(b => String(b.id) === String(id));
    if (box) applyZoom(box);
  }

  setPhase(phase);
  state.activeShowcaseId = id;
  $('status').textContent = phase === 'imageB'
    ? 'image B (clique pour image C)'
    : 'image C (clique pour revenir)';
}

function centerShowcase(img) {
  const sc = $('showcase');
  // The browser may reset scrollLeft to 0 when the showcase's content first
  // becomes visible (display:none -> block) and again on body class change.
  // We re-apply across multiple frames to make our centering stick.
  const apply = () => {
    const w = img.offsetWidth;
    if (!w) return;
    const target = w > sc.clientWidth ? Math.round((w - sc.clientWidth) / 2) : 0;
    sc.scrollLeft = target;
  };
  const start = () => {
    requestAnimationFrame(apply);
    requestAnimationFrame(() => requestAnimationFrame(apply));
    setTimeout(apply, 50);
    setTimeout(apply, 150);
  };
  if (img.complete && img.naturalWidth) start();
  else img.addEventListener('load', start, { once: true });
}

function applyZoom(box) {
  const stage = $('stage');
  const zoomInner = $('zoom-inner');

  // Determine stage's base size and viewport position (without any transform).
  let stageW, stageH, baseLeft, baseTop;
  if (mobile.active) {
    // Read what the browser actually renders. On real mobile, 100vh is the
    // LARGE viewport (full-screen) which differs from window.innerHeight when
    // the address bar is visible — using innerHeight here would misalign the
    // box during the zoom by tens of pixels.
    const dims = getStageNaturalDims();
    stageW = dims.w;
    stageH = dims.h;
    baseLeft = 0;       // stage is position:fixed top:0 left:0 in mobile
    baseTop = 0;
  } else {
    // Desktop: read base position by clearing transforms first.
    stage.style.transform = '';
    zoomInner.style.transform = '';
    const r = stage.getBoundingClientRect();
    stageW = r.width;
    stageH = r.height;
    baseLeft = r.left;
    baseTop = r.top;
  }

  const bcx = (box.x + box.w / 2) / MASTER_W * stageW;
  const bcy = (box.y + box.h / 2) / MASTER_H * stageH;
  const bw  = box.w / MASTER_W * stageW;
  const bh  = box.h / MASTER_H * stageH;

  // Mobile: match the showcase image B which is sized at height:100vh. Using
  // window.innerHeight here would scale the box to the VISIBLE viewport height
  // (smaller than 100vh when the mobile address bar is showing) and leave a
  // size mismatch with image B at the end of the zoom.
  const scale = mobile.active
    ? stageH / bh
    : Math.min(window.innerWidth / bw, window.innerHeight / bh) * 0.85;

  // Pan the stage so the box center ends at the viewport center.
  const panX = window.innerWidth / 2 - baseLeft - bcx;
  const panY = window.innerHeight / 2 - baseTop - bcy;

  // Restore CSS-defined transitions (overrides any inline 'none' from scroll).
  stage.style.transition = '';
  zoomInner.style.transition = '';

  // Stage handles the camera pan (faster easing — box reaches center first).
  stage.style.transform = `translate(${panX}px, ${panY}px)`;

  // Zoom-inner handles the scale (longer easing — finishes after pan settles).
  zoomInner.style.transformOrigin = `${bcx}px ${bcy}px`;
  zoomInner.style.transform = `scale(${scale})`;
}

function resetZoom() {
  const stage = $('stage');
  const zoomInner = $('zoom-inner');
  stage.style.transition = '';
  zoomInner.style.transition = '';
  // Stage returns to scroll-only (mobile) or no transform (desktop).
  stage.style.transform = mobile.active ? `translateX(${-mobile.scrollX}px)` : '';
  // Animate scale BACK around the same origin used to zoom IN (bcx, bcy).
  // Resetting transform-origin instantly would make the element snap to a
  // different anchor (default 50% 50%) before the scale transition runs —
  // visually that pops the image to the top-left as the user reported.
  // We clear the origin only AFTER the 1500ms zoom-out finishes.
  zoomInner.style.transform = '';
  setTimeout(() => {
    if (state.phase === 'home') {
      zoomInner.style.transformOrigin = '';
    }
  }, 1600);
}

$('showcase').addEventListener('click', () => {
  if (state.phase === 'imageB') {
    enterShowcase('imageC', state.activeShowcaseId);
  } else if (state.phase === 'imageC') {
    setPhase('home');
    state.activeShowcaseId = null;
    resetZoom();
    // Clear shown images after stage fade-in completes (so they don't peek through)
    setTimeout(() => {
      $('showcase').querySelectorAll('.show-img').forEach(i => i.classList.remove('shown'));
    }, 1500);
    $('status').textContent = statusText();
  }
});

// ============ EDITOR ====================================================
async function enterEditor() {
  setPhase('editor');
  // Nettoie les poignées HTML d'un éventuel mode précédent (perso, ancien cadre…)
  document.querySelectorAll('.char-handle').forEach(h => h.remove());
  document.querySelectorAll('.box-handle').forEach(h => h.remove());
  const layer = $('editor-layer');
  layer.innerHTML = '';
  for (const b of state.boxes) renderBox(b);
  state.selectedBoxId = null;
  $('box-panel').classList.remove('shown');
  $('status').textContent = 'Éditeur — drag pour tracer un cadre, poignées 🟦 pour redimensionner';
  if (sceneState.id) await loadCurrentSceneMeta();
}

async function exitEditor(saveFirst = true) {
  if (saveFirst) await saveBoxes();
  // Nettoie les poignées HTML pour ne pas laisser de vestiges sur le master en home
  document.querySelectorAll('.box-handle').forEach(h => h.remove());
  setPhase('home');
  await loadScene();
}

function renderBox(b) {
  // 1. Bordure SVG (juste visuelle, non interactive — pointer-events: none)
  const layer = $('editor-layer');
  const old = layer.querySelector(`g[data-id="${b.id}"]`);
  if (old) old.remove();
  // Retire aussi les poignées HTML existantes pour ce cadre
  document.querySelectorAll(`.box-handle[data-bid="${b.id}"]`).forEach(h => h.remove());

  const g = document.createElementNS(SVG_NS, 'g');
  g.dataset.id = b.id;

  const fill = document.createElementNS(SVG_NS, 'rect');
  fill.setAttribute('class', 'editor-box-fill');
  if (b.aspect === 'free') fill.classList.add('free-form');
  if (String(state.selectedBoxId) === String(b.id)) fill.classList.add('selected');
  fill.setAttribute('x', b.x);
  fill.setAttribute('y', b.y);
  fill.setAttribute('width', b.w);
  fill.setAttribute('height', b.h);
  // L'interactivité (clic pour sélectionner / drag pour déplacer) est portée
  // par les poignées HTML, pas par le SVG.
  g.appendChild(fill);

  if (b.subject) {
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'editor-label-text');
    text.setAttribute('x', b.x + 12);
    text.setAttribute('y', b.y + 36);
    text.style.fontSize = '24px';
    text.style.fontWeight = '500';
    text.textContent = b.subject.length > 32 ? b.subject.slice(0, 30) + '…' : b.subject;
    g.appendChild(text);
  }
  layer.appendChild(g);

  // 2. Poignées HTML (28×28 px, indépendantes du zoom, toujours cliquables)
  const zi = $('zoom-inner');
  function addBoxHandle(role, fracX, fracY, cls) {
    const h = document.createElement('div');
    h.className = 'char-handle box-handle ' + cls;
    h.dataset.role = role;
    h.dataset.bid = b.id;
    h.style.left = ((b.x + b.w * fracX) / MASTER_W * 100) + '%';
    h.style.top  = ((b.y + b.h * fracY) / MASTER_H * 100) + '%';
    h.addEventListener('mousedown', (e) => startBoxDrag(e, b, role));
    h.addEventListener('touchstart', (e) => startBoxDrag(e, b, role), { passive: false });
    h.addEventListener('click', (e) => { e.stopPropagation(); selectBox(b.id); });
    zi.appendChild(h);
  }
  addBoxHandle('move',   0.5, 0.5, 'move');
  addBoxHandle('right',  1.0, 0.5, 'right');
  addBoxHandle('bottom', 0.5, 1.0, 'bottom');
  addBoxHandle('brc',    1.0, 1.0, 'brc');
}

// Snap + validation gpt-image-2 pour un CADRE NORMAL.
// Mêmes contraintes que clampCharRect (multiples de 16, ratio ≤3:1, pixels
// ≥655k et ≤8.3M, dans le master) — donc chaque cadre est toujours valide
// pour gpt-image-2 sans déformation.
function clampBoxRect(x, y, w, h, lockedAspect) {
  if (w < 4) w = 256;
  if (h < 4) h = 256;
  // Si un ratio preset est verrouillé (aspect ≠ 'free'), on l'applique d'abord.
  if (lockedAspect && lockedAspect !== 'free' && ASPECTS[lockedAspect]) {
    const [rw, rh] = ASPECTS[lockedAspect];
    // Ajuste la dimension la plus contraignante
    const targetH = w * rh / rw;
    if (Math.abs(targetH - h) > 1) {
      // h doit suivre w (priorité au pointeur)
      h = targetH;
    }
  }
  // Le reste des contraintes (clamp gpt-image-2) — réutilise la même logique
  // que clampCharRect, qui agrandit proportionnellement si pixels < 655k.
  return clampCharRect(x, y, w, h);
}

function startBoxDrag(e, b, role) {
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
  const p = _evtPoint(e);
  state.boxDragRole = role;
  state.boxDragBox = b;
  state.boxDragStart = { x: p.x, y: p.y, ox: b.x, oy: b.y, ow: b.w, oh: b.h };
  selectBox(b.id);
  document.addEventListener('mousemove', onBoxDragMove);
  document.addEventListener('mouseup', endBoxDrag);
  document.addEventListener('touchmove', onBoxDragMove, { passive: false });
  document.addEventListener('touchend', endBoxDrag);
}

function onBoxDragMove(e) {
  if (!state.boxDragRole) return;
  if (e.cancelable) e.preventDefault();
  const p = _evtPoint(e);
  const dx = p.x - state.boxDragStart.x;
  const dy = p.y - state.boxDragStart.y;
  const b = state.boxDragBox;
  const role = state.boxDragRole;
  let nx = b.x, ny = b.y, nw = b.w, nh = b.h;
  if (role === 'move') {
    nx = state.boxDragStart.ox + dx;
    ny = state.boxDragStart.oy + dy;
  } else {
    if (role === 'right' || role === 'brc') nw = Math.max(16, state.boxDragStart.ow + dx);
    if (role === 'bottom' || role === 'brc') nh = Math.max(16, state.boxDragStart.oh + dy);
  }
  const clamped = clampBoxRect(nx, ny, nw, nh, b.aspect);
  b.x = clamped.x; b.y = clamped.y; b.w = clamped.w; b.h = clamped.h;
  renderBox(b);
}

function endBoxDrag() {
  state.boxDragRole = null;
  state.boxDragBox = null;
  state.boxDragStart = null;
  document.removeEventListener('mousemove', onBoxDragMove);
  document.removeEventListener('mouseup', endBoxDrag);
  document.removeEventListener('touchmove', onBoxDragMove);
  document.removeEventListener('touchend', endBoxDrag);
}

function selectBox(id) {
  state.selectedBoxId = String(id);
  $('editor-layer').querySelectorAll('.editor-box-fill').forEach(r => r.classList.remove('selected'));
  $('editor-layer').querySelector(`g[data-id="${id}"] .editor-box-fill`)?.classList.add('selected');
  const b = state.boxes.find(x => String(x.id) === String(id));
  if (!b) return;
  $('box-subject').value = b.subject || '';
  $('box-prompt-c').value = b.prompt_c || '';
  // The select may not have the box's current aspect option; fall back to '2:3'.
  const opt = $('box-aspect').querySelector(`option[value="${b.aspect}"]`);
  $('box-aspect').value = opt ? b.aspect : '2:3';
  $('box-aspect-display').textContent = aspectDisplay(b);
  // Hint résumé du select Quête (visible dans le summary fermé)
  refreshBoxQuestSummaryHint();
  $('box-panel').classList.add('shown');
}

function refreshBoxQuestSummaryHint() {
  const hint = $('box-quest-summary');
  if (!hint) return;
  const sel = $('box-quest-select');
  const linkedTitle = sel?.options[sel.selectedIndex]?.textContent || '— Aucune —';
  hint.textContent = linkedTitle.length > 24 ? linkedTitle.slice(0, 22) + '…' : linkedTitle;
}

// Bouton × pour fermer le box-panel sans rien faire.
$('close-box-panel').addEventListener('click', () => {
  deselectBox();
});

// ─── Drag & drop du box-panel par son header ─────────────────────
// Sur desktop, l'utilisateur peut empoigner le bandeau « CADRE SÉLECTIONNÉ »
// pour déplacer le panneau là où il veut (utile quand il masque un cadre
// qu'on veut sélectionner derrière). Position persistée en localStorage.
// Désactivé en mode mobile (le panneau est un bottom-sheet plein largeur).
(function setupBoxPanelDrag() {
  const panel = document.getElementById('box-panel');
  const header = panel?.querySelector('.box-panel-header');
  if (!panel || !header) return;
  const STORAGE_KEY = 'box-panel-pos';
  const MARGIN = 8;

  // Restaure la position sauvegardée si valide (et écran assez large)
  function restorePos() {
    if (document.body.classList.contains('mode-mobile')) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { left, top } = JSON.parse(raw);
      const maxL = window.innerWidth - panel.offsetWidth - MARGIN;
      const maxT = window.innerHeight - 60;
      const clL = Math.max(MARGIN, Math.min(left, maxL));
      const clT = Math.max(MARGIN, Math.min(top, maxT));
      panel.style.left = clL + 'px';
      panel.style.top = clT + 'px';
      panel.style.right = 'auto';
    } catch { /* corrupted entry, ignore */ }
  }
  // Restaure dès qu'on est en mode shown
  const observer = new MutationObserver(() => {
    if (panel.classList.contains('shown')) restorePos();
  });
  observer.observe(panel, { attributes: true, attributeFilter: ['class'] });

  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  function onDown(e) {
    if (document.body.classList.contains('mode-mobile')) return;
    // Évite de capturer un clic sur le bouton ×
    if (e.target.closest('.box-panel-close')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    startLeft = r.left; startTop = r.top;
    const p = (e.touches && e.touches[0]) || e;
    startX = p.clientX; startY = p.clientY;
    dragging = true;
    // Switch en positionnement absolu si on était encore en `right: 14px`
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';
    panel.style.right = 'auto';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
  }
  function onMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const p = (e.touches && e.touches[0]) || e;
    let nl = startLeft + (p.clientX - startX);
    let nt = startTop + (p.clientY - startY);
    const maxL = window.innerWidth - panel.offsetWidth - MARGIN;
    const maxT = window.innerHeight - 60;
    nl = Math.max(MARGIN, Math.min(nl, maxL));
    nt = Math.max(MARGIN, Math.min(nt, maxT));
    panel.style.left = nl + 'px';
    panel.style.top = nt + 'px';
  }
  function onUp() {
    if (!dragging) return;
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
    // Persiste la position finale
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: r.left, top: r.top }));
    } catch { /* localStorage plein ou désactivé : on ignore */ }
  }
  header.addEventListener('mousedown', onDown);
  header.addEventListener('touchstart', onDown, { passive: false });

  // Double-clic sur le header → reset position par défaut (haut droit)
  header.addEventListener('dblclick', (e) => {
    if (e.target.closest('.box-panel-close')) return;
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  });

  // Re-clamp si la fenêtre est redimensionnée
  window.addEventListener('resize', () => {
    if (panel.classList.contains('shown')
        && !document.body.classList.contains('mode-mobile')) restorePos();
  });
})();

function deselectBox() {
  state.selectedBoxId = null;
  $('editor-layer').querySelectorAll('.editor-box-fill').forEach(r => r.classList.remove('selected'));
  $('box-panel').classList.remove('shown');
}

// startDrag (legacy) : conservé en stub pour compat des appels externes.
function startDrag() { /* remplacé par startBoxDrag (poignées HTML) */ }

function onDragMove(e) {
  if (!dragState) return;
  const p = masterPoint(e);
  const dx = p.x - dragState.sx, dy = p.y - dragState.sy;
  const b = dragState.b;
  if (dragState.role === 'move') {
    b.x = clamp(dragState.ox + dx, 0, MASTER_W - b.w);
    b.y = clamp(dragState.oy + dy, 0, MASTER_H - b.h);
  } else if (b.aspect === 'free') {
    // Free-form: width and height resize independently from the bottom-right handle.
    const propW = Math.max(MIN_BOX, dragState.ow + dx);
    const propH = Math.max(MIN_BOX, dragState.oh + dy);
    const maxW = MASTER_W - b.x, maxH = MASTER_H - b.y;
    let nw = Math.min(propW, maxW), nh = Math.min(propH, maxH);
    // gpt-image-2 caps the aspect at 3:1. If the user drags past that, clamp.
    if (Math.max(nw, nh) / Math.max(1, Math.min(nw, nh)) > MAX_RATIO) {
      if (nw >= nh) nw = nh * MAX_RATIO; else nh = nw * MAX_RATIO;
    }
    b.w = nw; b.h = nh;
  } else {
    const [rw, rh] = ASPECTS[b.aspect] || ASPECTS['2:3'];
    const propW = Math.max(1, dragState.ow + dx);
    const propH = Math.max(1, dragState.oh + dy);
    let scale = Math.max(propW / rw, propH / rh);
    let nw = scale * rw, nh = scale * rh;
    const maxW = MASTER_W - b.x, maxH = MASTER_H - b.y;
    if (nw > maxW) { nw = maxW; nh = nw * rh / rw; }
    if (nh > maxH) { nh = maxH; nw = nh * rw / rh; }
    if (nw < MIN_BOX || nh < MIN_BOX) {
      const minScale = Math.max(MIN_BOX / rw, MIN_BOX / rh);
      nw = minScale * rw; nh = minScale * rh;
    }
    b.w = nw; b.h = nh;
  }
  renderBox(b);
}
function onDragEnd() {
  dragState = null;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
}

// Tracé d'un nouveau cadre dans le mode édition : drag sur le master (vide).
// Comme dans le mode personnage : tracé libre, snap16, clampBoxRect garantit
// la compatibilité gpt-image-2.
$('stage').addEventListener('mousedown', e => {
  if (state.phase !== 'editor') return;
  // Si on clique sur une poignée HTML, c'est elle qui gère.
  if (e.target.classList && e.target.classList.contains('box-handle')) return;
  // Si on clique à l'intérieur d'un cadre existant, on sélectionne sans dessiner.
  if (e.target.closest('#editor-layer g')) {
    const g = e.target.closest('#editor-layer g');
    if (g?.dataset?.id) selectBox(g.dataset.id);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const p = _evtPoint(e);
  drawState = { sx: p.x, sy: p.y };
});

$('stage').addEventListener('mousemove', e => {
  if (state.phase !== 'editor' || !drawState) return;
  const p = _evtPoint(e);
  const x0 = Math.min(drawState.sx, p.x);
  const y0 = Math.min(drawState.sy, p.y);
  const x1 = Math.max(drawState.sx, p.x);
  const y1 = Math.max(drawState.sy, p.y);
  drawState.preview = clampCharRect(snap16(x0), snap16(y0), x1 - x0, y1 - y0);
  let prev = $('editor-layer').querySelector('#preview-box');
  if (!prev) {
    prev = document.createElementNS(SVG_NS, 'rect');
    prev.setAttribute('id', 'preview-box');
    prev.setAttribute('class', 'editor-box-fill');
    prev.style.pointerEvents = 'none';
    $('editor-layer').appendChild(prev);
  }
  const r = drawState.preview;
  prev.setAttribute('x', r.x); prev.setAttribute('y', r.y);
  prev.setAttribute('width', r.w); prev.setAttribute('height', r.h);
});

document.addEventListener('mouseup', () => {
  if (!drawState) return;
  $('editor-layer').querySelector('#preview-box')?.remove();
  if (drawState.preview && drawState.preview.w >= 16 && drawState.preview.h >= 16) {
    const id = String(state.boxes.length ? Math.max(...state.boxes.map(b => +b.id)) + 1 : 1);
    // Ratio par défaut = 'free' (l'utilisateur peut le changer dans le panneau)
    const r = drawState.preview;
    const b = { id, x: r.x, y: r.y, w: r.w, h: r.h, aspect: 'free', subject: '' };
    state.boxes.push(b);
    renderBox(b);
    selectBox(b.id);
  }
  drawState = null;
});

// Box panel
$('box-subject').addEventListener('input', e => {
  const b = state.boxes.find(x => String(x.id) === String(state.selectedBoxId));
  if (!b) return;
  b.subject = e.target.value;
  renderBox(b);
  selectBox(b.id);
});

// Prompt image 2 (custom par cadre, sert à make_imageC)
$('box-prompt-c').addEventListener('input', e => {
  const b = state.boxes.find(x => String(x.id) === String(state.selectedBoxId));
  if (!b) return;
  b.prompt_c = e.target.value.trim();
  if (!b.prompt_c) delete b.prompt_c;
});
$('box-aspect').addEventListener('change', e => {
  const b = state.boxes.find(x => String(x.id) === String(state.selectedBoxId));
  if (!b) return;
  const newAspect = e.target.value;
  if (newAspect === 'free') {
    // Switch to free-form: keep current w/h and just relabel.
    b.aspect = 'free';
  } else {
    // Snap to a preset ratio while keeping the box's center and ~same area.
    const [rw, rh] = ASPECTS[newAspect];
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let scale = Math.sqrt(b.w * b.h / (rw * rh));
    let nw = scale * rw, nh = scale * rh;
    if (nw > MASTER_W) { nw = MASTER_W; nh = nw * rh / rw; }
    if (nh > MASTER_H) { nh = MASTER_H; nw = nh * rw / rh; }
    if (nw < MIN_BOX || nh < MIN_BOX) {
      const minScale = Math.max(MIN_BOX / rw, MIN_BOX / rh);
      nw = minScale * rw; nh = minScale * rh;
    }
    b.aspect = newAspect;
    b.w = nw; b.h = nh;
    b.x = clamp(cx - nw / 2, 0, MASTER_W - nw);
    b.y = clamp(cy - nh / 2, 0, MASTER_H - nh);
  }
  $('box-aspect-display').textContent = aspectDisplay(b);
  renderBox(b);
});

function aspectDisplay(b) {
  if (b.aspect === 'free') {
    // Show actual ratio (computed from w/h)
    const w = Math.round(b.w), h = Math.round(b.h);
    const r = w / h;
    return `Libre · ${w}×${h} (${r.toFixed(2)}:1)`;
  }
  return b.aspect;
}
$('delete-box').addEventListener('click', () => {
  if (!state.selectedBoxId) return;
  const id = String(state.selectedBoxId);
  state.boxes = state.boxes.filter(b => String(b.id) !== id);
  $('editor-layer').querySelector(`g[data-id="${id}"]`)?.remove();
  document.querySelectorAll(`.box-handle[data-bid="${id}"]`).forEach(h => h.remove());
  deselectBox();
});

// Regenerate the selected box's per-asset images (zoom 1 / zoom 2 / dessin)
// + optionally re-run vision analysis on this single box.
$('regen-box').addEventListener('click', async () => {
  if (!state.selectedBoxId) { alert('Sélectionne un cadre.'); return; }
  const opts = {
    imageB: $('regen-imageB').checked,
    imageC: $('regen-imageC').checked,
    dessin: $('regen-dessin').checked,
  };
  const wantVision = $('regen-vision')?.checked;
  if (!opts.imageB && !opts.imageC && !opts.dessin && !wantVision) {
    alert('Coche au moins une option à régénérer.');
    return;
  }
  const box = state.boxes.find(b => String(b.id) === String(state.selectedBoxId));
  if (!box) return;
  // Save current edits to box (subject/aspect/x/y/w/h) before regenerating.
  await saveBoxes();

  // Cas 1 : actions images (imageB/imageC/dessin) → endpoint regen-box.
  if (opts.imageB || opts.imageC || opts.dessin) {
    showOverlay({ step: `Régénération du cadre ${box.id}…`, step_index: 0, total_steps: 1 });
    try {
      const r = await fetch('/api/regen-box', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ box, opts, scene_id: sceneState.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
      // Quand on a aussi vision : on attend la fin du regen-box AVANT
      // d'enchaîner avec describe-boxes (le serveur a un mutex _running).
      if (wantVision) {
        await pollUntilDone({ reloadAfter: false });
        await _runVisionOnBoxes([String(box.id)], false);
      } else {
        pollUntilDone({ reloadAfter: false });
      }
    } catch (err) {
      setOverlayError(err.message);
    }
    return;
  }

  // Cas 2 : vision uniquement (pas d'images sélectionnées) → describe-boxes direct.
  showGptOverlay('Analyse vision du cadre…');
  try {
    await _runVisionOnBoxes([String(box.id)], false);
  } finally {
    hideGptOverlay();
  }
});

// Helper interne : POST /api/describe-boxes en mode sélectif.
// Renvoie le rapport (utile pour les loggers). Rafraîchit le meta côté front
// pour que la Fiche client se mette à jour immédiatement.
async function _runVisionOnBoxes(boxIds, force) {
  const r = await fetch('/api/describe-boxes', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      scene_ids: [sceneState.id], box_ids: boxIds, force: !!force,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('Vision échouée : ' + (j.error || 'HTTP ' + r.status)); return j; }
  await loadCurrentSceneMeta();  // rafraîchit la fiche client
  return j;
}

$('exit-editor').addEventListener('click', () => exitEditor(true));
$('generate-from-editor').addEventListener('click', async () => {
  if (!state.boxes.length) { alert('Trace au moins un cadre.'); return; }
  await saveBoxes();
  await runPipeline();
});

async function saveBoxes() {
  await fetch('/api/boxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ boxes: state.boxes }),
  });
}

// Click on empty editor area deselects
$('editor-layer').addEventListener('click', e => {
  if (e.target === $('editor-layer')) deselectBox();
});

// ============ SETTINGS PANEL & GENERATION ===============================
$('settings-btn').addEventListener('click', e => {
  e.stopPropagation();
  $('settings-panel').classList.toggle('open');
  $('settings-btn').classList.toggle('open');
});
document.addEventListener('click', e => {
  const panel = $('settings-panel');
  const btn = $('settings-btn');
  if (panel.classList.contains('open') &&
      !panel.contains(e.target) && !btn.contains(e.target)) {
    panel.classList.remove('open');
    btn.classList.remove('open');
  }
});

// ---- Sliders du module Tracé (2 niveaux : N1 blanc / N2 or) ----
// Les valeurs s'appliquent en CSS variables (preview live), persistent dans
// localStorage (entre sessions), ET — quand un module est chargé — dans
// `sceneState.meta.trace_style = { n1: {...}, n2: {...} }` poussé via
// /api/scenes/<id>/meta (debounce). Le PLAYER lit `meta.trace_style` et
// applique les vars CSS aux .observation-skel (n1) / .quest-skel (n2).
// Compat : si meta.trace_style = { stroke, opacity, glow } (ancien format
// mono-niveau), on le promeut en { n1: <ancien>, n2: <ancien> } à la lecture.

const TRACE_DEFAULTS = { stroke: 3, opacity: 0.92, glow: 0 };

function _lsKey(level, prop) { return `accroche-${prop}-${level}`; }

// Lit la valeur courante depuis localStorage avec fallback sur l'ancien key
// (mono-niveau) — pour migrer en douceur les utilisateurs qui avaient déjà
// configuré un style avant la mise à jour.
function _readLevelProp(level, prop, fallback) {
  const v = localStorage.getItem(_lsKey(level, prop));
  if (v !== null) return parseFloat(v);
  const legacy = localStorage.getItem(`accroche-${prop}`);
  if (legacy !== null) return parseFloat(legacy);
  return fallback;
}

let _traceStylePushTimer = null;
function pushTraceStyleToScene() {
  if (!sceneState || !sceneState.id) return;
  clearTimeout(_traceStylePushTimer);
  _traceStylePushTimer = setTimeout(async () => {
    const trace_style = {
      n1: {
        stroke:  _readLevelProp('n1', 'stroke',  TRACE_DEFAULTS.stroke),
        opacity: _readLevelProp('n1', 'opacity', TRACE_DEFAULTS.opacity),
        glow:    _readLevelProp('n1', 'glow',    TRACE_DEFAULTS.glow),
      },
      n2: {
        stroke:  _readLevelProp('n2', 'stroke',  TRACE_DEFAULTS.stroke),
        opacity: _readLevelProp('n2', 'opacity', TRACE_DEFAULTS.opacity),
        glow:    _readLevelProp('n2', 'glow',    TRACE_DEFAULTS.glow),
      },
    };
    try { await saveSceneMeta({ trace_style }); } catch {}
  }, 500);
}

// Applique une valeur (stroke / opacity / glow) sur les vars CSS pour le
// niveau cible. Met aussi à jour les anciennes vars (--stroke-w sans
// suffixe) pour préserver le fallback côté player si CSS pas migré.
function _applyLevelProp(level, prop, value) {
  const root = document.documentElement;
  const num = Number(value);
  if (prop === 'stroke') {
    root.style.setProperty(`--stroke-w-${level}`, String(num));
  } else if (prop === 'opacity') {
    root.style.setProperty(`--stroke-opacity-${level}`, String(num));
  } else if (prop === 'glow') {
    root.style.setProperty(`--glow-r-${level}`, `${(num * 18).toFixed(1)}px`);
    root.style.setProperty(`--glow-a-${level}`, (num * 0.95).toFixed(3));
  }
}

// Wire un slider (ID = `${prop}-${level}`, valeur = `${prop}-${level}-val`).
function _wireTraceSlider(level, prop) {
  const inp = $(`${prop}-${level}`);
  const val = $(`${prop}-${level}-val`);
  if (!inp || !val) return;
  const fmt = (n) => prop === 'stroke' ? n.toFixed(1) : n.toFixed(2);
  function apply(v, fromUser) {
    const num = Number(v);
    val.textContent = fmt(num);
    _applyLevelProp(level, prop, num);
    localStorage.setItem(_lsKey(level, prop), String(num));
    if (fromUser) pushTraceStyleToScene();
  }
  const saved = _readLevelProp(level, prop, TRACE_DEFAULTS[prop]);
  inp.value = saved;
  apply(saved, false);
  inp.addEventListener('input', e => apply(e.target.value, true));
}

['n1', 'n2'].forEach(level => {
  ['stroke', 'opacity', 'glow'].forEach(prop => _wireTraceSlider(level, prop));
});

// Au chargement d'un module : si meta.trace_style existe, on pré-remplit
// les sliders. Accepte le NOUVEAU format ({n1:{}, n2:{}}) et l'ANCIEN
// (stroke/opacity/glow mono-niveau, promu vers les 2 niveaux).
function applyTraceStyleFromMeta(meta) {
  if (!meta || !meta.trace_style) return;
  const ts = meta.trace_style;
  // Promotion ancien format → nouveau
  const n1 = ts.n1 || ts;
  const n2 = ts.n2 || ts;
  for (const [level, src] of [['n1', n1], ['n2', n2]]) {
    for (const prop of ['stroke', 'opacity', 'glow']) {
      const v = src && typeof src[prop] === 'number' ? src[prop] : null;
      if (v === null) continue;
      const inp = $(`${prop}-${level}`);
      const val = $(`${prop}-${level}-val`);
      if (inp) inp.value = v;
      if (val) val.textContent = prop === 'stroke' ? v.toFixed(1) : v.toFixed(2);
      _applyLevelProp(level, prop, v);
      localStorage.setItem(_lsKey(level, prop), String(v));
    }
  }
  // Met aussi les anciennes vars CSS (sans suffixe) pour le fallback du
  // PLAYER s'il n'est pas encore migré (sur les nouveaux navigateurs c'est
  // le n2 qui domine puisque .quest-skel l'utilisera).
  const root = document.documentElement;
  if (typeof n1.stroke === 'number')  root.style.setProperty('--stroke-w', String(n1.stroke));
  if (typeof n1.opacity === 'number') root.style.setProperty('--stroke-opacity', String(n1.opacity));
  if (typeof n1.glow === 'number') {
    root.style.setProperty('--glow-r', `${(n1.glow * 18).toFixed(1)}px`);
    root.style.setProperty('--glow-a', (n1.glow * 0.95).toFixed(3));
    document.body.classList.toggle('no-glow', n1.glow === 0 && (typeof n2.glow !== 'number' || n2.glow === 0));
  }
  // Empêche le code legacy de planter — l'ancien bloc de code lisait
  // applyTraceStyleFromMeta pour stroke/opacity/glow mono.
  return;
}

$('gen-master').addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) return;
  $('settings-panel').classList.remove('open');
  showOverlay({ step: 'Génération du master 2560x1440…', step_index: 0, total_steps: 1 });
  try {
    const r = await fetch('/api/master/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
    pollUntilDone({ reloadAfter: true });
  } catch (err) { setOverlayError(err.message); }
});

$('upload-master').addEventListener('click', () => $('upload-input').click());
$('upload-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('settings-panel').classList.remove('open');
  showOverlay({ step: 'Upload + outpainting via GPT…', step_index: 0, total_steps: 2 });
  const fd = new FormData();
  fd.append('image', file);
  try {
    const r = await fetch('/api/master/upload', { method: 'POST', body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
    pollUntilDone({ reloadAfter: true });
  } catch (err) { setOverlayError(err.message); }
});

$('enter-editor').addEventListener('click', enterEditor);
$('run-pipeline').addEventListener('click', async () => {
  if (!state.boxes.length) {
    alert('Trace d\'abord au moins un cadre via "Éditer les cadres".'); return;
  }
  $('settings-panel').classList.remove('open');
  await runPipeline();
});

async function runPipeline() {
  showOverlay({ step: 'Démarrage…', step_index: 0, total_steps: 3 });
  try {
    const r = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ boxes: state.boxes, prompt: $('prompt').value }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
    pollUntilDone({ reloadAfter: true });
  } catch (err) { setOverlayError(err.message); }
}

function showOverlay(s) {
  $('gen-overlay').classList.add('open');
  $('gen-step').textContent = s.step || 'Préparation…';
  $('gen-progress').textContent = `${s.step_index ?? 0} / ${s.total_steps ?? 0}`;
  $('gen-error').textContent = s.error || '';
}
function setOverlayError(msg) {
  $('gen-error').textContent = msg;
}
function hideOverlay() { $('gen-overlay').classList.remove('open'); }

async function pollUntilDone({ reloadAfter = true } = {}) {
  while (true) {
    const r = await fetch('/api/status', { cache: 'no-store' });
    const s = await r.json();
    if (s.error) { showOverlay(s); return; }
    if (s.running) { showOverlay(s); await new Promise(r => setTimeout(r, 1500)); continue; }
    hideOverlay();
    if (reloadAfter) {
      setPhase('home');
      await loadScene();
    }
    return;
  }
}

// ============ AUTHORING (scenes / questions / quests) ==================
// Editing a saved scene? URL ?scene=<id> means "load this scene's assets into
// public/ then operate on it." Without ?scene, the editor is in 'draft' mode
// and "Sauver comme module" creates a new scene from current public/.
const sceneState = {
  id: null,           // current scene id (null = draft)
  meta: null,         // last fetched meta.json
};

function getQueryParam(name) {
  const m = new URLSearchParams(location.search).get(name);
  return m || null;
}

async function loadCurrentSceneMeta() {
  if (!sceneState.id) return null;
  const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}`, { cache: 'no-store' });
  if (!r.ok) return null;
  sceneState.meta = await r.json();
  refreshSceneBanner();
  // Applique le trace_style du module sur les sliders + CSS, pour que
  // l'éditeur reflète exactement ce que verra le joueur.
  if (typeof applyTraceStyleFromMeta === 'function') {
    applyTraceStyleFromMeta(sceneState.meta);
  }
  return sceneState.meta;
}

function refreshSceneBanner() {
  const banner = $('current-scene-banner');
  const name = $('current-scene-name');
  if (sceneState.meta && sceneState.id) {
    banner.style.display = 'block';
    name.textContent = sceneState.meta.name;
    $('save-scene').textContent = 'Mettre à jour le module';
  } else {
    banner.style.display = 'none';
    $('save-scene').textContent = 'Sauver comme module';
  }
}

async function saveSceneMeta(patch) {
  if (!sceneState.id) {
    alert('Sauve d\'abord la scène comme module avant d\'ajouter questions/quêtes.');
    return null;
  }
  const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/meta`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    alert('Erreur : ' + (j.error || r.status));
    return null;
  }
  const j = await r.json();
  sceneState.meta = j.meta;
  refreshSceneBanner();
  return j.meta;
}

// ----- Save / update module -----
$('save-scene').addEventListener('click', async () => {
  if (sceneState.id) {
    // Update — push current public/.boxes.json into the scene snapshot.
    // For a full update of master/images, we re-snapshot the whole scene
    // under the same name, replacing the old folder.
    const ok = confirm('Mettre à jour ce module avec l\'état actuel (master, cadres, images générées) ?\n\nLes questions et quêtes existantes seront conservées.');
    if (!ok) return;
    // Capture existing questions/quests
    const prevMeta = sceneState.meta || {};
    // Re-snapshot under a temp name then merge the questions/quests/name
    // Easier: just call /meta with current boxes; for asset diffs we already
    // operate on public/ which the scene's load points to. So we update
    // boxes via /meta and ALSO re-snapshot assets through a fresh save.
    await saveBoxes();
    await saveSceneMeta({ boxes: state.boxes });
    // Re-copy current public/ assets into the scene's directory:
    const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/resnap`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    }).catch(() => null);
    // The /resnap endpoint may not exist yet — fallback: ignore.
    alert('Module mis à jour.');
    return;
  }
  const name = prompt('Nom du module :', 'Nouvelle scène');
  if (!name || !name.trim()) return;
  const cat = prompt('Catégorie (optionnel) :', '') || '';
  await saveBoxes();
  const r = await fetch('/api/scenes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), category: cat.trim() }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert('Erreur : ' + (j.error || r.status)); return; }
  sceneState.id = j.scene.id;
  sceneState.meta = j.scene;
  refreshSceneBanner();
  // Pousse le trace_style courant (sliders éditeur) dans le meta du nouveau
  // module — comme ça les joueurs verront les contours avec le même style.
  pushTraceStyleToScene();
  // Update URL so reload preserves context
  const u = new URL(location.href);
  u.searchParams.set('scene', sceneState.id);
  history.replaceState(null, '', u.toString());
  alert(`Module "${j.scene.name}" sauvegardé.`);
});

// =================== OBSERVATION QUESTIONS (level 1) ===================
let editingQuestionIndex = -1;  // -1 = new

function openQuestionModal(idx = -1) {
  editingQuestionIndex = idx;
  const q = idx >= 0 ? (sceneState.meta?.level1_questions || [])[idx] : null;
  $('q-text').value = q?.text || '';
  $('q-explanation').value = q?.explanation || '';
  const choicesBox = $('q-choices');
  choicesBox.innerHTML = '';
  const choices = q?.choices && q.choices.length ? q.choices : ['', '', '', ''];
  const correct = q?.correct_index ?? 0;
  choices.forEach((c, i) => addChoiceRow(choicesBox, c, i === correct, false));
  $('question-modal').classList.add('shown');
}

function closeQuestionModal() {
  $('question-modal').classList.remove('shown');
  editingQuestionIndex = -1;
  // Si on annule et qu'on venait de Missions, on y retourne (onglet N1).
  if (_returnToMissionsAfterSave) {
    _returnToMissionsAfterSave = false;
    openMissionsModal('n1');
  }
}

function addChoiceRow(container, value = '', marked = false, isQuest = false) {
  const row = document.createElement('div');
  row.className = 'choice-row' + (marked ? (isQuest ? ' is-best' : ' is-correct') : '');
  row.innerHTML = `
    <button type="button" class="choice-mark" title="${isQuest ? 'Meilleur choix' : 'Bonne réponse'}">${marked ? '✓' : ''}</button>
    <div class="choice-body">
      <input type="text" placeholder="Texte du choix" value="${value.replace(/"/g, '&quot;')}">
      ${isQuest ? '<textarea placeholder="Explication / feedback après réponse"></textarea>' : ''}
    </div>
    <button type="button" class="choice-del" title="Supprimer">×</button>`;
  container.appendChild(row);

  row.querySelector('.choice-mark').addEventListener('click', () => {
    const cls = isQuest ? 'is-best' : 'is-correct';
    container.querySelectorAll('.choice-row').forEach(r => {
      r.classList.remove(cls);
      r.querySelector('.choice-mark').textContent = '';
    });
    row.classList.add(cls);
    row.querySelector('.choice-mark').textContent = '✓';
  });
  row.querySelector('.choice-del').addEventListener('click', () => {
    row.remove();
  });
  return row;
}

function readChoices(container, isQuest = false) {
  const rows = container.querySelectorAll('.choice-row');
  const choices = [];
  let correctIdx = 0;
  rows.forEach((row, i) => {
    const cls = isQuest ? 'is-best' : 'is-correct';
    if (row.classList.contains(cls)) correctIdx = i;
    if (isQuest) {
      const text = row.querySelector('input').value.trim();
      const explanation = row.querySelector('textarea').value.trim();
      if (text) choices.push({ text, explanation });
    } else {
      const text = row.querySelector('input').value.trim();
      if (text) choices.push(text);
    }
  });
  return { choices, correctIdx };
}

$('q-add-choice').addEventListener('click', () => addChoiceRow($('q-choices'), '', false, false));
$('q-cancel').addEventListener('click', closeQuestionModal);

$('q-save').addEventListener('click', async () => {
  const text = $('q-text').value.trim();
  const explanation = $('q-explanation').value.trim();
  const { choices, correctIdx } = readChoices($('q-choices'), false);
  if (!text) { alert('Énoncé manquant.'); return; }
  if (choices.length < 2) { alert('Au moins 2 choix.'); return; }
  const q = {
    id: editingQuestionIndex >= 0
      ? sceneState.meta.level1_questions[editingQuestionIndex].id
      : 'q' + Date.now(),
    text, choices, correct_index: correctIdx, explanation,
  };
  const list = [...(sceneState.meta?.level1_questions || [])];
  if (editingQuestionIndex >= 0) list[editingQuestionIndex] = q;
  else list.push(q);
  await saveSceneMeta({ level1_questions: list });
  // closeQuestionModal s'occupe de rouvrir la modale Missions si le flag
  // _returnToMissionsAfterSave est posé (cf. patch sur closeQuestionModal).
  closeQuestionModal();
});

// Flag posé quand on entre dans un modal d'édition depuis la modale Missions,
// pour pouvoir y revenir après save/cancel (au lieu de fermer net).
let _returnToMissionsAfterSave = false;

function renderQuestionsList() {
  const box = $('ql-items');
  box.innerHTML = '';
  const list = sceneState.meta?.level1_questions || [];
  if (!list.length) {
    box.innerHTML = '<div style="color:rgba(255,255,255,0.45);font-size:12px;padding:12px;text-align:center;">Aucune question — clique sur « + Ajouter » ou « 🪄 Générer ».</div>';
    return;
  }
  list.forEach((q, i) => {
    if (q._rating === 'refused') return;  // refused → caché de l'UI
    const item = buildQuestionItem(q, i, list);
    box.appendChild(item);
  });
}

// Construit un item de liste pour une question N1, avec ses boutons de
// notation, son expansion inline des choix, et ses formulaires inline pour
// les notes (✦) et raisons de refus (✗).
function buildQuestionItem(q, i, list) {
  const item = document.createElement('div');
  item.className = 'ql-item ' + (q._rating ? `rated-${q._rating}` : '');
  const isValidated = q._rating === 'good' || q._rating === 'nuanced';
  const noteHtml = (q._rating === 'nuanced' && q._note)
    ? `<div class="ql-note">${escapeHtmlAttr(q._note)}</div>` : '';
  const choicesRowsHtml = (q.choices || []).map((c, ci) => {
    const isCorrect = ci === q.correct_index;
    const choiceRating = (q._choice_ratings && q._choice_ratings[ci]) || null;
    const cr = choiceRating?.rating;
    if (cr === 'refused') return ''; // distracteur refusé masqué pendant régénération
    // Tooltip Q&A contextuel : bonne réponse vs distracteur
    const labelKey = isCorrect ? 'answer_correct' : 'answer_distractor';
    const lbls = RATE_LABELS[labelKey].any;
    return `
      <div class="ql-choice-row" data-ci="${ci}">
        <span class="mark ${isCorrect ? 'best' : ''}">${isCorrect ? '✓' : '·'}</span>
        <span class="text">${escapeHtmlAttr(c)}</span>
        <span class="spinner"></span>
        <span class="rate-btns">
          <button class="rate-btn good ${cr==='good'?'is-on':''}"     data-kind="answer" data-action="good"     ${!isValidated?'disabled':''} title="${escapeHtmlAttr(lbls.good)}">★</button>
          <button class="rate-btn nuanced ${cr==='nuanced'?'is-on':''}" data-kind="answer" data-action="nuanced"  ${!isValidated?'disabled':''} title="${escapeHtmlAttr(lbls.nuanced)}">✦</button>
          <button class="rate-btn refused ${cr==='refused'?'is-on':''}" data-kind="answer" data-action="refused"  ${!isValidated?'disabled':''} title="${escapeHtmlAttr(lbls.refused)}">✗</button>
        </span>
      </div>`;
  }).join('');

  // Row dédiée à l'explication (un seul .explanation partagé par la question)
  const explRating = q._explanation_rating?.rating || null;
  const explLbls = RATE_LABELS.explanation.any;
  const explRowHtml = q.explanation ? `
      <div class="ql-choice-row" data-ci="explanation" style="border-top:1px solid rgba(255,255,255,0.10);margin-top:8px;padding-top:10px;">
        <span class="mark" title="Explication">ℹ</span>
        <span class="text" style="font-style:italic;color:rgba(212,184,122,0.85);">${escapeHtmlAttr(q.explanation)}</span>
        <span class="rate-btns">
          <button class="rate-btn good ${explRating==='good'?'is-on':''}"     data-kind="explanation" data-action="good"     ${!isValidated?'disabled':''} title="${escapeHtmlAttr(explLbls.good)}">★</button>
          <button class="rate-btn nuanced ${explRating==='nuanced'?'is-on':''}" data-kind="explanation" data-action="nuanced"  ${!isValidated?'disabled':''} title="${escapeHtmlAttr(explLbls.nuanced)}">✦</button>
          <button class="rate-btn refused ${explRating==='refused'?'is-on':''}" data-kind="explanation" data-action="refused"  ${!isValidated?'disabled':''} title="${escapeHtmlAttr(explLbls.refused)}">✗</button>
        </span>
      </div>` : '';

  const qLbls = RATE_LABELS.question_text.any;
  // Layout :
  //   • Ligne 1 (toujours visible)   : toggle ▸ + texte plein largeur + Éditer/Suppr.
  //   • Ligne 2 (déplié seulement)   : boutons ★ ✦ ✗ pour noter la question.
  //   • Suit la rate-input-row + le bloc choices/explication (déplié seulement).
  item.innerHTML = `
    <div class="ql-row-title">
      <button class="ql-toggle" title="Voir les choix">▸</button>
      <div class="ql-text"><strong>${i + 1}.</strong> ${escapeHtmlAttr(q.text)}${noteHtml}</div>
      <div class="ql-actions">
        <button class="edit">Éditer</button>
        <button class="del">Suppr</button>
      </div>
    </div>
    <div class="ql-row-controls">
      <span style="font-size:11px;color:rgba(255,255,255,0.55);margin-right:8px;">Noter la question :</span>
      <span class="rate-btns">
        <button class="rate-btn good ${q._rating==='good'?'is-on':''}"       data-kind="question" data-action="good"    title="${escapeHtmlAttr(qLbls.good)}">★</button>
        <button class="rate-btn nuanced ${q._rating==='nuanced'?'is-on':''}"  data-kind="question" data-action="nuanced" title="${escapeHtmlAttr(qLbls.nuanced)}">✦</button>
        <button class="rate-btn refused ${q._rating==='refused'?'is-on':''}"  data-kind="question" data-action="refused" title="${escapeHtmlAttr(qLbls.refused)}">✗</button>
      </span>
    </div>
    <div class="rate-input-row" data-for="question"></div>
    <div class="ql-choices">${choicesRowsHtml}${explRowHtml}</div>
  `;

  // Toggle expansion des choix. La persistance est gérée via q._expanded
  // pour que le volet reste ouvert même après une notation (qui ne re-render
  // plus la liste — cf. submitRating ci-dessous).
  const choicesDiv = item.querySelector('.ql-choices');
  const toggleBtn = item.querySelector('.ql-toggle');
  if (q._expanded) {
    choicesDiv.classList.add('shown');
    toggleBtn.textContent = '▾';
  }
  toggleBtn.addEventListener('click', () => {
    const shown = choicesDiv.classList.toggle('shown');
    toggleBtn.textContent = shown ? '▾' : '▸';
    q._expanded = shown;
  });

  // Boutons rating sur la QUESTION
  item.querySelectorAll('.rate-btn[data-kind="question"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.dataset.action;
      handleRatingClick(item, q, list, 1, 'question', action, null);
    });
  });

  // Boutons rating sur chaque réponse + sur l'explication
  item.querySelectorAll('.ql-choice-row').forEach(row => {
    const ciAttr = row.dataset.ci;
    const isExplanation = ciAttr === 'explanation';
    const ci = isExplanation ? null : parseInt(ciAttr, 10);
    row.querySelectorAll('.rate-btn[data-kind="answer"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const action = btn.dataset.action;
        handleRatingClick(item, q, list, 1, 'answer', action, ci, row);
      });
    });
    row.querySelectorAll('.rate-btn[data-kind="explanation"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const action = btn.dataset.action;
        handleRatingClick(item, q, list, 1, 'explanation', action, null, row);
      });
    });
  });

  // Boutons Éditer / Suppr classiques
  item.querySelector('.edit').addEventListener('click', () => {
    _returnToMissionsAfterSave = true;
    _missionsLastTab = 'n1';
    closeMissionsModal();
    openQuestionModal(i);
  });
  item.querySelector('.del').addEventListener('click', async () => {
    if (!confirm('Supprimer cette question ?')) return;
    const newList = list.filter((_, j) => j !== i);
    await saveSceneMeta({ level1_questions: newList });
    renderQuestionsList();
  });
  return item;
}

// Gère un clic sur un bouton de rating dans la liste N1 inline (Missions).
// Comportement unifié : ANY rating ouvre un popover avec textarea + Valider/
// Annuler. Le commentaire est TOUJOURS OPTIONNEL ; on peut valider sans
// note. Le label du popover est contextuel (Q&A "Pourquoi est-ce X ?")
// selon le type de champ et le statut (correct vs distracteur).
function handleRatingClick(item, q, list, level, kind, action, answerIdx, choiceRow) {
  let inputRow;
  if (kind === 'question') {
    inputRow = item.querySelector('.rate-input-row[data-for="question"]');
  } else {
    inputRow = choiceRow.querySelector(':scope > .rate-input-row');
    if (!inputRow) {
      inputRow = document.createElement('div');
      inputRow.className = 'rate-input-row';
      choiceRow.appendChild(inputRow);
    }
  }

  // Détermine le fieldType pour piocher le bon libellé Q&A
  let fieldKey;
  if (kind === 'question') {
    fieldKey = 'question_text';
  } else if (kind === 'answer') {
    const isCorrect = answerIdx === q.correct_index;
    fieldKey = isCorrect ? 'answer_correct' : 'answer_distractor';
  } else if (kind === 'explanation') {
    fieldKey = 'explanation';
  } else {
    fieldKey = 'question_text'; // fallback safety
  }
  const labelsAll = RATE_LABELS[fieldKey]?.any || RATE_LABELS.question_text.any;
  const promptText = labelsAll[action];

  inputRow.innerHTML = `
    <div class="label">${escapeHtmlAttr(promptText)}</div>
    <textarea placeholder="${escapeHtmlAttr(promptText)} (optionnel)"></textarea>
    <div class="actions">
      <button class="cancel">Annuler</button>
      <button class="save">Valider</button>
    </div>`;
  inputRow.classList.add('shown');
  const ta = inputRow.querySelector('textarea');
  setTimeout(() => ta.focus(), 50);
  inputRow.querySelector('.cancel').onclick = () => {
    inputRow.classList.remove('shown');
    inputRow.innerHTML = '';
  };
  inputRow.querySelector('.save').onclick = () => {
    const note = ta.value.trim();  // peut être vide — c'est volontaire
    inputRow.classList.remove('shown');
    inputRow.innerHTML = '';
    submitRating(item, q, list, level, kind, action, note, answerIdx, choiceRow);
  };
}

async function submitRating(item, q, list, level, kind, rating, note, answerIdx, choiceRow) {
  const body = {
    level, item_id: q.id, kind, rating, note,
  };
  if (kind === 'answer') body.answer_idx = answerIdx;
  try {
    const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/rate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('rate ' + r.status);
  } catch (e) {
    alert('Notation échouée : ' + e.message);
    return;
  }
  // Mise à jour locale optimiste du meta
  if (kind === 'question' || kind === 'quest') {
    q._rating = rating;
    q._note = note || null;
  } else if (kind === 'answer') {
    if (level === 1) {
      q._choice_ratings = q._choice_ratings || [];
      while (q._choice_ratings.length < (q.choices || []).length) q._choice_ratings.push(null);
      q._choice_ratings[answerIdx] = { rating, note: note || null };
    } else {
      const c = q.dialogue_choices?.[answerIdx];
      if (c) { c._rating = rating; c._note = note || null; }
    }
  } else if (kind === 'explanation') {
    q._explanation_rating = { rating, note: note || null };
  }

  // Cas spécial : distracteur refusé → régénération auto + rerender
  // (le distracteur va changer, on doit redessiner pour montrer le nouveau).
  if (kind === 'answer' && rating === 'refused') {
    if (choiceRow) choiceRow.classList.add('regenerating');
    try {
      const rr = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/regen-distractor`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          level, item_id: q.id, choice_idx: answerIdx, reason: note,
        }),
      });
      const rrj = await rr.json();
      if (!rr.ok) throw new Error(rrj.error || 'regen ' + rr.status);
      const newChoice = rrj.new_choice;
      if (level === 1) {
        q.choices[answerIdx] = newChoice.text;
        if (q._choice_ratings) q._choice_ratings[answerIdx] = null;
      } else {
        q.dialogue_choices[answerIdx] = {
          text: newChoice.text || '',
          is_best: false,
          explanation: newChoice.explanation || '',
        };
      }
    } catch (e) {
      alert('Régénération du distracteur échouée : ' + e.message);
      return;
    }
    if (level === 1) renderQuestionsList();
    else renderQuestsList();
    showRagToast('✓ Distracteur régénéré');
    return;
  }

  // Cas spécial : question (N1) ou quête (N2) notée 'refused' → masquée de
  // l'UI (filtre rated-refused), donc rerender nécessaire.
  if ((kind === 'question' || kind === 'quest') && rating === 'refused') {
    if (level === 1) renderQuestionsList();
    else renderQuestsList();
    showRagToast('✓ Noté · question masquée');
    return;
  }

  // Cas standard : pas de rerender, on met à jour en PLACE pour que le
  // volet déplié reste ouvert et que l'utilisateur puisse enchaîner les
  // notations des réponses sans devoir le rouvrir à chaque fois.
  _updateRatingInPlace(item, q, kind, rating, note, answerIdx, choiceRow);
  showRagToast('✓ Noté · envoyé au corpus');
}

// Met à jour visuellement les boutons rating + le badge de couleur du
// .ql-item sans rerender la liste complète. Préserve l'expansion utilisateur.
function _updateRatingInPlace(item, q, kind, rating, note, answerIdx, choiceRow) {
  // Cible la rangée de boutons concernée par le kind
  let btnGroup = null;
  if (kind === 'question' || kind === 'quest') {
    // Les boutons de la question sont dans .ql-row-controls (N1) ou
    // n'existent plus sur la liste N2 (notation déplacée dans Éditer).
    btnGroup = item.querySelector('.ql-row-controls .rate-btns');
    // Met à jour le liseré coloré gauche du item
    item.classList.remove('rated-good', 'rated-nuanced', 'rated-refused');
    item.classList.add(`rated-${rating}`);
    // Ajoute ou met à jour la note nuancée à côté du texte
    const txt = item.querySelector('.ql-text');
    if (txt) {
      const oldNote = txt.querySelector('.ql-note');
      if (oldNote) oldNote.remove();
      if (rating === 'nuanced' && note) {
        const div = document.createElement('div');
        div.className = 'ql-note';
        div.textContent = note;
        txt.appendChild(div);
      }
    }
    // Une fois la question notée good/nuanced, on active les boutons de
    // notation des réponses (qui étaient disabled jusque-là).
    if (rating === 'good' || rating === 'nuanced') {
      item.querySelectorAll('.rate-btn[data-kind="answer"], .rate-btn[data-kind="explanation"]')
        .forEach(b => { b.disabled = false; });
    }
  } else if (kind === 'answer' || kind === 'explanation') {
    btnGroup = choiceRow?.querySelector('.rate-btns');
  }
  if (!btnGroup) return;
  // Toggle des classes is-on sur les 3 boutons
  btnGroup.querySelectorAll('.rate-btn').forEach(b => {
    b.classList.toggle('is-on', b.dataset.action === rating);
  });
}

// Toast discret en bas à droite. Confirme à l'utilisateur que sa
// notation a bien été envoyée au corpus RAG. S'efface seul après 1.8s.
function showRagToast(message) {
  let toast = document.getElementById('rag-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rag-toast';
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px;
      background: rgba(80, 180, 100, 0.92);
      color: white; padding: 10px 16px;
      border-radius: 8px; font-size: 13px; font-weight: 500;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      z-index: 9999;
      opacity: 0; transform: translateY(8px);
      transition: opacity 200ms ease, transform 200ms ease;
      pointer-events: none;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  clearTimeout(showRagToast._timer);
  showRagToast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
  }, 1800);
}

$('add-observation-question').addEventListener('click', async () => {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  await loadCurrentSceneMeta();
  openQuestionModal(-1);
});
$('manage-questions').addEventListener('click', async () => {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  await loadCurrentSceneMeta();
  openMissionsModal('n1');
});
$('ql-add').addEventListener('click', () => {
  _missionsLastTab = 'n1';
  _returnToMissionsAfterSave = true;
  closeMissionsModal();
  openQuestionModal(-1);
});
// Legacy ghost button — referrer compat (le bouton est caché, mais on garde
// le listener au cas où). Ferme simplement la modale.
$('ql-close').addEventListener('click', () => closeMissionsModal());

// =================== QUESTS (level 2) ==================================
let editingQuestIndex = -1;
let editingQuestBoxId = null;

// Référence aux raters de champ (title + intro), réinitialisée à chaque
// ouverture du modal. Permet à saveQuest de récupérer tous les ratings.
let _qmFieldRaters = null;

function openQuestModal(boxId, idx = -1) {
  editingQuestIndex = idx;
  editingQuestBoxId = boxId;
  const quests = sceneState.meta?.quests || [];
  const q = idx >= 0 ? quests[idx] : null;
  // Re-populate the "cadre associé" <select> with all current boxes.
  const sel = $('qu-box');
  sel.innerHTML = '<option value="">— Choisir un cadre —</option>';
  for (const b of state.boxes) {
    const opt = document.createElement('option');
    opt.value = String(b.id);
    opt.textContent = `Cadre ${b.id}${b.subject ? ' — ' + b.subject.trim().slice(0, 36) : ''}`;
    sel.appendChild(opt);
  }
  sel.value = String(q?.box_id ?? boxId ?? '');
  $('qu-title').value = q?.title || '';
  $('qu-intro').value = q?.intro_text || '';
  const cbox = $('qu-choices');
  cbox.innerHTML = '';
  const choices = q?.dialogue_choices && q.dialogue_choices.length
    ? q.dialogue_choices : [{ text: '', explanation: '' }, { text: '', explanation: '' }];
  let bestIdx = choices.findIndex(c => c.is_best);
  if (bestIdx < 0) bestIdx = 0;

  // Init le slot de raters par champ
  _qmFieldRaters = { title: null, intro: null, choices: [] };

  // Attache le rating au champ TITRE
  const titleInput = $('qu-title');
  // Retire d'anciennes rangées de rating qui auraient pu trainer
  _cleanupOldFieldRatings(titleInput);
  _qmFieldRaters.title = attachFieldRating(
    titleInput, 'title', false,
    (q?._field_ratings?.title) || {},
  );
  // Attache le rating au champ INTRO
  const introTa = $('qu-intro');
  _cleanupOldFieldRatings(introTa);
  _qmFieldRaters.intro = attachFieldRating(
    introTa, 'intro', false,
    (q?._field_ratings?.intro) || {},
  );

  // Choix : pour chaque ligne, on attache 2 raters (text + explain) et on
  // affiche un badge "★ MEILLEUR CHOIX" ou "DISTRACTEUR".
  choices.forEach((c, i) => {
    const isBest = i === bestIdx;
    const row = addChoiceRow(cbox, c.text || '', isBest, true);
    if (c.explanation) row.querySelector('textarea').value = c.explanation;

    // Badge de statut en haut de la row (info-only, non éditable)
    const badge = document.createElement('div');
    badge.className = 'choice-kind-badge ' + (isBest ? 'best' : '');
    badge.textContent = isBest ? '★ MEILLEURE ACCROCHE' : 'DISTRACTEUR';
    row.insertBefore(badge, row.firstChild);

    // Attache rating sur le TEXTE et l'EXPLICATION du choix
    const inputEl = row.querySelector('input');
    const explainTa = row.querySelector('textarea');
    const existing = c._field_ratings || {};
    const rText = attachFieldRating(inputEl, 'choice_text', isBest, existing.text || {});
    const rExpl = attachFieldRating(explainTa, 'choice_explain', isBest, existing.explanation || {});
    _qmFieldRaters.choices.push({ rText, rExpl, isBest });
  });

  // Bandeau "🪄 Générer cette quête" : visible UNIQUEMENT en mode création
  // (pas en édition d'une quête existante). On l'affiche dès qu'un cadre
  // est sélectionné.
  const genRow = $('qu-gen-row');
  genRow.style.display = (idx < 0 && sel.value) ? '' : 'none';
  // Fiche client : populée dès qu'un cadre est sélectionné
  refreshFicheClient(sel.value);
  sel.onchange = () => {
    genRow.style.display = (idx < 0 && sel.value) ? '' : 'none';
    refreshFicheClient(sel.value);
  };

  $('quest-modal').classList.add('shown');
}

// Rafraîchit la fiche client (lecture seule) en haut du quest-modal à
// partir de meta.boxes[bid]._analysis. Si pas d'analyse, propose un
// CTA pour la générer.
function refreshFicheClient(boxId) {
  const container = $('qu-fiche-client');
  const content = $('qu-fiche-content');
  if (!container || !content) return;
  if (!boxId) { container.style.display = 'none'; return; }
  const box = (sceneState.meta?.boxes || []).find(b => String(b.id) === String(boxId));
  if (!box) { container.style.display = 'none'; return; }
  const analysis = box._analysis;
  if (!analysis || !analysis.personnages?.length) {
    container.style.display = 'block';
    content.innerHTML = `
      <div style="color:rgba(255,255,255,0.55);font-style:italic;margin-bottom:8px;">
        Aucune analyse vision pour ce cadre.
      </div>
      <button class="btn" id="qu-fiche-generate" style="font-size:11px;padding:6px 12px;">
        👁 Analyser ce cadre maintenant
      </button>`;
    $('qu-fiche-generate')?.addEventListener('click', async () => {
      showGptOverlay('GPT-5.4 analyse le cadre…');
      try {
        const r = await fetch('/api/describe-boxes', {
          method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ scene_ids: [sceneState.id], force: false }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await loadCurrentSceneMeta();
        refreshFicheClient(boxId);
      } catch (e) {
        alert('Analyse échouée : ' + e.message);
      } finally { hideGptOverlay(); }
    });
    return;
  }
  container.style.display = 'block';
  const tags = analysis.tags || [];
  const tagsHtml = tags.length
    ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:8px;">${tags.map(t => `<span style="display:inline-flex;align-items:center;background:rgba(212,184,122,0.10);border:1px solid rgba(212,184,122,0.35);color:rgba(232,210,160,0.95);padding:2px 8px;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:0.03em;">${escapeHtmlAttr(String(t))}</span>`).join('')}</div>`
    : '';
  const persosHtml = (analysis.personnages || []).map((p, i) => {
    // Schéma observationnel pur : qui / situation seulement.
    // Aucun champ prescriptif (l'approche est gérée par GPT+RAG en aval).
    const qui = p.qui || p.physique || '';
    const situation = p.situation || '';
    // Fallback ancien schéma si nouveaux champs absents
    if (!qui && !situation) {
      return `
        <div style="margin-top:${i>0?10:0}px;padding-top:${i>0?10:0}px;${i>0?'border-top:1px solid rgba(255,255,255,0.10);':''}color:rgba(255,255,255,0.55);font-style:italic;">
          Analyse au format ancien — clique « 👁 Analyser » pour la moderniser.
          ${facetLine('Physique', p.physique)}
          ${facetLine('Tenue', p.tenue)}
        </div>`;
    }
    return `
      <div style="margin-top:${i>0?10:0}px;padding-top:${i>0?10:0}px;${i>0?'border-top:1px solid rgba(255,255,255,0.10);':''}">
        <div style="font-weight:600;color:rgba(255,255,255,0.95);margin-bottom:6px;">Personne ${i+1}</div>
        ${facetLine('Qui', qui)}
        ${facetLine('Situation', situation)}
      </div>`;
  }).join('');
  // Bloc dynamique de groupe (cadres multi-personnages)
  const dyn = analysis.dynamique_groupe;
  let dynHtml = '';
  if (dyn && typeof dyn === 'object') {
    // Schéma observationnel : interaction / rôles / atmosphère seulement.
    // implication_vendeur retiré (prescription = job du GPT+RAG en aval).
    const dynRows = [
      facetLine('Interaction', dyn.interaction),
      facetLine('Rôles', dyn.roles),
      facetLine('Atmosphère', dyn.atmosphere),
    ].filter(Boolean).join('');
    if (dynRows) {
      dynHtml = `
        <div style="margin-top:12px;padding:10px;background:rgba(212,184,122,0.06);border-left:3px solid rgba(212,184,122,0.55);border-radius:4px;">
          <div style="font-weight:700;color:rgba(232,210,160,1);margin-bottom:6px;letter-spacing:0.04em;font-size:11px;text-transform:uppercase;">Dynamique de groupe</div>
          ${dynRows}
        </div>`;
    }
  } else if (typeof dyn === 'string' && dyn.trim()) {
    dynHtml = `
      <div style="margin-top:12px;padding:10px;background:rgba(212,184,122,0.06);border-left:3px solid rgba(212,184,122,0.55);border-radius:4px;">
        <div style="font-weight:700;color:rgba(232,210,160,1);margin-bottom:6px;letter-spacing:0.04em;font-size:11px;text-transform:uppercase;">Dynamique de groupe</div>
        ${facetLine('', dyn)}
      </div>`;
  }
  content.innerHTML = (persosHtml || '<div style="color:rgba(255,255,255,0.55);font-style:italic;">Analyse vide.</div>') + dynHtml + tagsHtml;
}
function facetLine(label, value) {
  if (!value || !String(value).trim()) return '';
  return `<div style="margin-top:2px;"><span style="color:rgba(255,255,255,0.55);">${escapeHtmlAttr(label)} :</span> ${escapeHtmlAttr(value)}</div>`;
}
function chip(label, value, color) {
  if (!value || !String(value).trim()) return '';
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(0,0,0,0.30);border:1px solid ${color};color:${color};padding:3px 8px;border-radius:999px;font-size:10px;font-weight:600;letter-spacing:0.04em;">${escapeHtmlAttr(label)} : ${escapeHtmlAttr(value)}</span>`;
}

// Supprime les .field-rate-row + .field-rate-textarea qui suivent un
// élément (pour éviter de dupliquer quand on ré-ouvre le modal).
function _cleanupOldFieldRatings(el) {
  let next = el.nextElementSibling;
  while (next && (next.classList.contains('field-rate-row') || next.classList.contains('field-rate-textarea'))) {
    const toRemove = next;
    next = next.nextElementSibling;
    toRemove.remove();
  }
}

// Labels contextuels au format Q&A : la phrase au survol et le placeholder
// du textarea sont une QUESTION qui invite l'utilisateur à expliquer.
// Le commentaire est TOUJOURS optionnel — on peut valider sans note.
// Structure : RATE_LABELS[fieldType][isBest?'best':'not_best'|'any'][rating]
const RATE_LABELS = {
  // ====== Niveau 1 (QCM observation) ======
  question_text: {
    any: {
      good: "Pourquoi est-ce une BONNE question ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans cette question ?",
      refused: "Pourquoi est-ce une MAUVAISE question ?",
    },
  },
  answer_correct: {
    any: {
      good: "Pourquoi est-ce LA bonne réponse ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans cette réponse ?",
      refused: "Pourquoi ce n'est PAS la bonne réponse ?",
    },
  },
  answer_distractor: {
    any: {
      good: "Pourquoi est-ce un BON distracteur ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans ce distracteur ?",
      refused: "Pourquoi est-ce un MAUVAIS distracteur ?",
    },
  },
  explanation: {
    any: {
      good: "Pourquoi est-ce une BONNE explication ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans cette explication ?",
      refused: "Pourquoi est-ce une MAUVAISE explication ?",
    },
  },
  // ====== Niveau 2 (quest dialogue) ======
  title: {
    any: {
      good: "Pourquoi est-ce un BON titre ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans le titre ?",
      refused: "Pourquoi est-ce un MAUVAIS titre ?",
    },
  },
  intro: {
    any: {
      good: "Pourquoi est-ce une BONNE intro ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans l'intro ?",
      refused: "Pourquoi est-ce une MAUVAISE intro ?",
    },
  },
  choice_text: {
    best: {
      good: "Pourquoi est-ce LA bonne accroche ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans cette accroche ?",
      refused: "Pourquoi ce n'est PAS la bonne accroche ?",
    },
    not_best: {
      good: "Pourquoi est-ce un BON distracteur ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans ce distracteur ?",
      refused: "Pourquoi est-ce un MAUVAIS distracteur ?",
    },
  },
  choice_explain: {
    best: {
      good: "Pourquoi est-ce une BONNE explication de pourquoi c'est LA bonne accroche ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans l'explication du meilleur choix ?",
      refused: "Pourquoi est-ce une MAUVAISE explication ?",
    },
    not_best: {
      good: "Pourquoi est-ce une BONNE explication de pourquoi c'est un distracteur ?",
      nuanced: "Qu'est-ce qui pourrait être amélioré dans l'explication du distracteur ?",
      refused: "Pourquoi est-ce une MAUVAISE explication de pourquoi c'est un distracteur ?",
    },
  },
};

// Attache une rangée de notation à un élément. Retourne un objet
// { get(): { rating, note }, setStatus(label) } utilisable à la sauvegarde.
//
// `fieldType` : 'title' | 'intro' | 'choice_text' | 'choice_explain'
// `isBest`    : booléen indiquant si on rate l'élément du meilleur choix
//               (utilisé pour adapter les labels)
// `initial`   : { rating, note } pré-existant (cas édition)
//
// Le résultat est inséré DIRECTEMENT après l'élément cible.
function attachFieldRating(targetEl, fieldType, isBest, initial = {}) {
  const labelsKey = (fieldType === 'choice_text' || fieldType === 'choice_explain')
    ? (isBest ? 'best' : 'not_best') : 'any';
  const labels = RATE_LABELS[fieldType][labelsKey];
  const initRating = initial.rating || null;
  const initNote = initial.note || '';

  const row = document.createElement('div');
  row.className = 'field-rate-row' + (initRating ? ' has-rating' : '');
  row.innerHTML = `
    <span class="rate-btns">
      <button class="rate-btn good ${initRating==='good'?'is-on':''}"     data-action="good"    type="button">★<span class="lbl">${escapeHtmlAttr(labels.good)}</span></button>
      <button class="rate-btn nuanced ${initRating==='nuanced'?'is-on':''}" data-action="nuanced" type="button">✦<span class="lbl">${escapeHtmlAttr(labels.nuanced)}</span></button>
      <button class="rate-btn refused ${initRating==='refused'?'is-on':''}" data-action="refused" type="button">✗<span class="lbl">${escapeHtmlAttr(labels.refused)}</span></button>
    </span>
    <span class="rate-status"></span>
  `;
  const textarea = document.createElement('textarea');
  textarea.className = 'field-rate-textarea';
  textarea.value = initNote;
  // Insère row + textarea juste après targetEl
  targetEl.insertAdjacentElement('afterend', row);
  row.insertAdjacentElement('afterend', textarea);

  const statusEl = row.querySelector('.rate-status');
  function updateStatus(rating) {
    if (!rating) {
      statusEl.textContent = '';
      row.classList.remove('has-rating');
    } else {
      statusEl.textContent = labels[rating];
      row.classList.add('has-rating');
    }
  }
  function showTextarea(prefill) {
    if (prefill && !textarea.value) {
      textarea.value = '';
      textarea.placeholder = prefill;
    }
    textarea.classList.add('shown');
    setTimeout(() => textarea.focus(), 60);
  }
  function hideTextarea() {
    textarea.classList.remove('shown');
  }

  updateStatus(initRating);
  // Le textarea s'ouvre dès qu'une note est posée (★, ✦ ou ✗). Commentaire
  // optionnel — on garde même vide. Permet à l'utilisateur d'expliquer
  // POURQUOI son rating quel qu'il soit.
  if (initRating) showTextarea(labels[initRating]);

  let current = initRating;
  row.querySelectorAll('.rate-btn').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const action = b.dataset.action;
      const same = b.classList.contains('is-on');
      row.querySelectorAll('.rate-btn').forEach(x => x.classList.remove('is-on'));
      if (same) {
        current = null;
        updateStatus(null);
        hideTextarea();
        return;
      }
      b.classList.add('is-on');
      current = action;
      updateStatus(action);
      // Toujours ouvrir le textarea (commentaire optionnel) — placeholder
      // = la question contextuelle "Pourquoi est-ce X ?".
      showTextarea(labels[action]);
    });
  });

  return {
    get: () => ({
      rating: current,
      note: textarea.value.trim() || null,
      labels,  // utile pour le payload
    }),
  };
}

function closeQuestModal() {
  $('quest-modal').classList.remove('shown');
  editingQuestIndex = -1;
  editingQuestBoxId = null;
  // Si on annule et qu'on venait de Missions, on y retourne (onglet N2).
  if (_returnToMissionsAfterSave) {
    _returnToMissionsAfterSave = false;
    openMissionsModal('n2');
  }
}

$('qu-add-choice').addEventListener('click', () => {
  const row = addChoiceRow($('qu-choices'), '', false, true);
  // Ajout manuel = pas un meilleur choix (on lock le toggle dans le quest-modal)
  const badge = document.createElement('div');
  badge.className = 'choice-kind-badge';
  badge.textContent = 'DISTRACTEUR';
  row.insertBefore(badge, row.firstChild);
  const inputEl = row.querySelector('input');
  const explainTa = row.querySelector('textarea');
  const rText = attachFieldRating(inputEl, 'choice_text', false, {});
  const rExpl = attachFieldRating(explainTa, 'choice_explain', false, {});
  _qmFieldRaters?.choices?.push({ rText, rExpl, isBest: false });
});
$('qu-cancel').addEventListener('click', closeQuestModal);

// 🪄 Génère la quête entière via GPT-5.4 (vision sur l'image du cadre)
// et pré-remplit les champs du modal. L'utilisateur peut alors éditer
// et noter avant de sauver.
$('qu-gen-btn').addEventListener('click', async () => {
  const boxId = $('qu-box').value.trim();
  if (!boxId) { alert('Sélectionne d\'abord un cadre.'); return; }
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  showGptOverlay('GPT-5.4 analyse le cadre et génère 4 choix de dialogue…');
  try {
    const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/generate-quest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ box_id: boxId }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    const quest = j.quest;
    $('qu-gen-row').dataset.boxDescription = quest._box_description || '';
    // Re-init complet du modal avec les nouvelles données
    // (on passe par un mock pour réutiliser openQuestModal pré-rempli)
    sceneState.meta.quests = sceneState.meta.quests || [];
    // On simule une "édition" temporaire en injectant le quest dans la liste
    // sans le persister, puis on ré-ouvre. Plus simple : on remplit à la main.
    $('qu-title').value = quest.title || '';
    $('qu-intro').value = quest.intro_text || '';
    const cbox = $('qu-choices');
    cbox.innerHTML = '';
    _qmFieldRaters.choices = [];
    // Re-attache les raters de title + intro (en repartant de l'état vide)
    _cleanupOldFieldRatings($('qu-title'));
    _cleanupOldFieldRatings($('qu-intro'));
    _qmFieldRaters.title = attachFieldRating($('qu-title'), 'title', false, {});
    _qmFieldRaters.intro = attachFieldRating($('qu-intro'), 'intro', false, {});
    (quest.dialogue_choices || []).forEach((c, i) => {
      const isBest = !!c.is_best;
      const row = addChoiceRow(cbox, c.text || '', isBest, true);
      if (c.explanation) row.querySelector('textarea').value = c.explanation;
      const badge = document.createElement('div');
      badge.className = 'choice-kind-badge ' + (isBest ? 'best' : '');
      badge.textContent = isBest ? '★ MEILLEURE ACCROCHE' : 'DISTRACTEUR';
      row.insertBefore(badge, row.firstChild);
      const inputEl = row.querySelector('input');
      const explainTa = row.querySelector('textarea');
      const rText = attachFieldRating(inputEl, 'choice_text', isBest, {});
      const rExpl = attachFieldRating(explainTa, 'choice_explain', isBest, {});
      _qmFieldRaters.choices.push({ rText, rExpl, isBest });
    });
  } catch (e) {
    alert('Génération échouée : ' + e.message);
  } finally {
    hideGptOverlay();
  }
});

async function saveQuest() {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  const title = $('qu-title').value.trim();
  const intro = $('qu-intro').value.trim();
  const boxIdSel = $('qu-box').value.trim();
  const { choices, correctIdx } = readChoices($('qu-choices'), true);
  if (!boxIdSel) { alert('Choisis un cadre associé pour cette quête.'); return; }
  if (!title) { alert('Titre manquant.'); return; }
  if (choices.length < 2) { alert('Au moins 2 choix de dialogue.'); return; }

  // Collecte tous les ratings par champ via _qmFieldRaters
  const fr = _qmFieldRaters || { title: null, intro: null, choices: [] };
  const titleRate = fr.title?.get() || { rating: null, note: null };
  const introRate = fr.intro?.get() || { rating: null, note: null };
  const choiceRates = fr.choices.map(c => ({
    text: c.rText.get(),
    explain: c.rExpl.get(),
    isBest: c.isBest,
  }));

  // Commentaire toujours OPTIONNEL — on accepte les notes sans explication.
  // Le rating seul (★ ✦ ✗) + le contexte (texte + box) est déjà précieux
  // pour le fichier corrections, même sans le « pourquoi ».

  // Construit le payload des field_ratings (à persister dans meta) + le
  // payload backend pour corrections_n2.txt.
  const quest_field_ratings = {};
  if (titleRate.rating) quest_field_ratings.title = { rating: titleRate.rating, note: titleRate.note };
  if (introRate.rating) quest_field_ratings.intro = { rating: introRate.rating, note: introRate.note };

  const dialogue_choices = choices.map((c, i) => {
    const ent = {
      text: c.text, explanation: c.explanation, is_best: i === correctIdx,
    };
    const cr = choiceRates[i];
    if (cr && (cr.text.rating || cr.explain.rating)) {
      ent._field_ratings = {};
      if (cr.text.rating) ent._field_ratings.text = { rating: cr.text.rating, note: cr.text.note };
      if (cr.explain.rating) ent._field_ratings.explanation = { rating: cr.explain.rating, note: cr.explain.note };
    }
    return ent;
  });

  const id = editingQuestIndex >= 0
    ? sceneState.meta.quests[editingQuestIndex].id
    : 'quest-' + Date.now();

  const quest = {
    id, box_id: String(boxIdSel),
    title, intro_text: intro,
    dialogue_choices,
  };
  if (Object.keys(quest_field_ratings).length) quest._field_ratings = quest_field_ratings;
  if (editingQuestIndex >= 0) {
    const prev = sceneState.meta.quests[editingQuestIndex];
    if (prev._origin) quest._origin = prev._origin;
  }

  const list = [...(sceneState.meta?.quests || [])];
  if (editingQuestIndex >= 0) list[editingQuestIndex] = quest;
  else list.push(quest);
  await saveSceneMeta({ quests: list });

  // Envoie les ratings au backend pour append corrections_n2.txt enrichi.
  // On envoie TOUTES les notes posées (titre, intro, et chaque texte/explication
  // de choix), avec leur contexte cadre (box_id, subject, description).
  const anyRating = !!(titleRate.rating || introRate.rating
    || choiceRates.some(c => c.text.rating || c.explain.rating));
  if (anyRating) {
    const boxObj = state.boxes.find(b => String(b.id) === String(boxIdSel));
    const boxDescription = $('qu-gen-row').dataset.boxDescription
      || (sceneState.meta?.boxes || []).find(b => String(b.id) === String(boxIdSel))?._description
      || '';
    const payload = {
      item_id: id,
      box_id: String(boxIdSel),
      box_subject: boxObj?.subject || '',
      box_description: boxDescription,
      quest_title: title,
      intro_text: intro,
      title_rating: titleRate.rating ? { rating: titleRate.rating, note: titleRate.note, label: titleRate.labels[titleRate.rating] } : null,
      intro_rating: introRate.rating ? { rating: introRate.rating, note: introRate.note, label: introRate.labels[introRate.rating] } : null,
      choices: dialogue_choices.map((c, i) => {
        const cr = choiceRates[i];
        return {
          idx: i,
          text: c.text,
          is_best: c.is_best,
          explanation: c.explanation,
          text_rating: cr.text.rating ? { rating: cr.text.rating, note: cr.text.note, label: cr.text.labels[cr.text.rating] } : null,
          explain_rating: cr.explain.rating ? { rating: cr.explain.rating, note: cr.explain.note, label: cr.explain.labels[cr.explain.rating] } : null,
        };
      }),
    };
    try {
      await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/rate-quest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      console.warn('rate-quest failed', e);
    }
  }

  closeQuestModal();
}

$('qu-save').addEventListener('click', () => saveQuest());

// La liste de quêtes par cadre (in-panel) a été supprimée :
// l'utilisateur édite désormais les quêtes depuis le module "Quêtes".
// Dans le panneau de cadre il y a juste un select pour ASSOCIER une quête.
function refreshBoxQuestSelect() {
  const sel = $('box-quest-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">— Aucune —</option>';
  if (!sceneState.meta) return;
  const quests = sceneState.meta.quests || [];
  for (const q of quests) {
    const opt = document.createElement('option');
    opt.value = q.id;
    opt.textContent = q.title || ('Quête ' + q.id);
    sel.appendChild(opt);
  }
  // Quelle quête est actuellement liée au cadre sélectionné ?
  if (state.selectedBoxId) {
    const linked = quests.find(q => String(q.box_id) === String(state.selectedBoxId));
    sel.value = linked ? linked.id : '';
  }
  refreshBoxQuestSummaryHint();
}

// Quand on change le select, on met à jour le box_id de la quête choisie pour
// pointer sur le cadre courant (et on retire l'éventuel ancien lien d'une autre
// quête vers ce cadre).
$('box-quest-select').addEventListener('change', async (e) => {
  if (!sceneState.id || !state.selectedBoxId) return;
  const newQuestId = e.target.value;
  const quests = [...(sceneState.meta?.quests || [])];
  // Détache toute quête actuellement liée à ce cadre.
  for (const q of quests) {
    if (String(q.box_id) === String(state.selectedBoxId)) q.box_id = '';
  }
  // Lie la quête sélectionnée au cadre courant.
  if (newQuestId) {
    const target = quests.find(q => q.id === newQuestId);
    if (target) target.box_id = String(state.selectedBoxId);
  }
  await saveSceneMeta({ quests });
});

// Hook : à la sélection d'un cadre, met à jour le select des quêtes.
const _origSelectBox = selectBox;
selectBox = function (id) {
  _origSelectBox(id);
  refreshBoxQuestSelect();
};

// Modale Missions unifiée : 2 sous-onglets (N1 Observations / N2 Quêtes).
// L'onglet actif est conservé pour pouvoir rouvrir la modale au même endroit
// après un add/edit (les modales d'édition unitaires se posent par-dessus).
let _missionsLastTab = 'n1';
function openMissionsModal(tab = 'n1') {
  _missionsLastTab = tab;
  // Active le bon sous-onglet
  document.querySelectorAll('.missions-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mtab === tab);
  });
  document.querySelectorAll('.missions-pane').forEach(p => {
    p.style.display = p.dataset.mpane === tab ? '' : 'none';
  });
  // Rend les deux listes (peu cher, et garantit que les 2 sont à jour)
  renderQuestionsList();
  renderQuestsList();
  $('missions-modal').classList.add('shown');
}
function closeMissionsModal() {
  $('missions-modal').classList.remove('shown');
}
// Click sur un sous-onglet : change le panneau visible (sans fermer la modale)
document.querySelectorAll('.missions-tab').forEach(btn => {
  btn.addEventListener('click', () => openMissionsModal(btn.dataset.mtab));
});
$('missions-close').addEventListener('click', () => {
  closeMissionsModal();
  refreshQuestsOverview();
});

// Backwards-compat : l'ancienne fonction est conservée comme alias.
function openQuestsListModal() { openMissionsModal('n2'); }
function renderQuestsList() {
  const box = $('quests-list-items');
  box.innerHTML = '';
  const quests = sceneState.meta?.quests || [];
  if (!quests.length) {
    box.innerHTML = '<div style="color:rgba(255,255,255,0.45);font-size:12px;padding:12px;text-align:center;">Aucune quête. Clique sur « + Nouvelle quête » ou « 🪄 Générer ».</div>';
    return;
  }
  // Phase 3 : groupement par box_id (multi-variantes).
  const byBox = new Map();
  quests.forEach((q, i) => {
    const key = String(q.box_id || '?');
    if (!byBox.has(key)) byBox.set(key, []);
    byBox.get(key).push({ q, i });
  });
  const boxesById = Object.fromEntries((sceneState.meta?.boxes || []).map(b => [String(b.id), b]));
  for (const [boxId, variants] of byBox) {
    // Filtre refused
    const visible = variants.filter(v => v.q._rating !== 'refused');
    if (!visible.length) continue;
    const group = document.createElement('div');
    group.className = 'ql-group';
    const boxObj = boxesById[boxId];
    const boxLabel = boxObj?.subject?.trim() || `cadre ${boxId}`;
    // Header de groupe (cadre + dropdown variantes + + Variante)
    let activeIdx = 0;
    const renderGroup = () => {
      const v = visible[activeIdx];
      group.innerHTML = '';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(212,184,122,0.08);border:1px solid rgba(212,184,122,0.25);border-radius:6px;margin-bottom:6px;';
      const dropdown = visible.length > 1
        ? `<select class="variant-select" style="background:rgba(0,0,0,0.4);color:#ddd;border:1px solid rgba(255,255,255,0.15);border-radius:4px;padding:4px 6px;font-size:11px;">${visible.map((vv, k) => `<option value="${k}" ${k===activeIdx?'selected':''}>Variante ${k+1} / ${visible.length}</option>`).join('')}</select>`
        : `<span style="font-size:11px;color:rgba(255,255,255,0.45);">Variante unique</span>`;
      head.innerHTML = `
        <strong style="color:rgba(212,184,122,0.95);font-size:12px;flex:1;">CADRE ${boxId} · ${escapeHtmlAttr(boxLabel)}</strong>
        ${dropdown}
        <button class="add-variant" title="Ajouter une variante" style="background:rgba(212,184,122,0.20);border:1px solid rgba(212,184,122,0.55);color:rgba(240,210,150,1);padding:4px 8px;border-radius:4px;font-size:11px;cursor:pointer;">+ Variante</button>
      `;
      group.appendChild(head);
      // Item de la variante active
      group.appendChild(buildQuestItem(v.q, v.i, quests));
      // Wire le dropdown
      const sel = head.querySelector('.variant-select');
      if (sel) sel.addEventListener('change', () => {
        activeIdx = parseInt(sel.value, 10);
        renderGroup();
      });
      head.querySelector('.add-variant').addEventListener('click', async () => {
        if (variants.length >= 50) { alert('Limite de 50 variantes atteinte pour ce cadre.'); return; }
        _returnToMissionsAfterSave = true;
        _missionsLastTab = 'n2';
        closeMissionsModal();
        openQuestModal(boxId, -1);
      });
    };
    renderGroup();
    box.appendChild(group);
  }
}

function buildQuestItem(q, i, allQuests) {
  const item = document.createElement('div');
  item.className = 'ql-item ' + (q._rating ? `rated-${q._rating}` : '');
  const isValidated = q._rating === 'good' || q._rating === 'nuanced';
  const hasImgs = q._has_images
    ? '<span style="color:rgba(80,227,164,0.85);">✓ images</span>'
    : '<span style="color:rgba(255,184,77,0.85);">⚠ images manquantes</span>';
  const noteHtml = (q._rating === 'nuanced' && q._note)
    ? `<div class="ql-note">${escapeHtmlAttr(q._note)}</div>` : '';
  // Niveau 2 : on AFFICHE les choix mais on NE LES NOTE PAS dans la liste
  // Missions. La notation des choix N2 se fait dans le modal d'édition de
  // la quête (clic Éditer), où l'on peut aussi régénérer la quête entière.
  const choicesRowsHtml = (q.dialogue_choices || []).map((c, ci) => {
    return `
      <div class="ql-choice-row" data-ci="${ci}">
        <span class="mark ${c.is_best ? 'best' : ''}">${c.is_best ? '★' : '·'}</span>
        <span class="text">« ${escapeHtmlAttr(c.text || '')} »</span>
      </div>`;
  }).join('');

  // Niveau 2 : pas de boutons de notation sur la quête globale dans la
  // liste Missions. Tout se note champ par champ dans la modale d'édition
  // (clic Éditer) — c'est plus précis et utilisable par le RAG.
  item.innerHTML = `
    <div class="ql-row-title">
      <button class="ql-toggle" title="Voir les choix">▸</button>
      <div class="ql-text">
        <strong>${escapeHtmlAttr(q.title || 'Quête')}</strong>
        <div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:2px;">${hasImgs}</div>
        ${noteHtml}
      </div>
      <div class="ql-actions">
        <button class="edit">Éditer</button>
        <button class="del">Suppr</button>
      </div>
    </div>
    <div class="ql-choices">${choicesRowsHtml}</div>
  `;
  const choicesDiv = item.querySelector('.ql-choices');
  const toggleBtn = item.querySelector('.ql-toggle');
  if (q._expanded) {
    choicesDiv.classList.add('shown');
    toggleBtn.textContent = '▾';
  }
  toggleBtn.addEventListener('click', () => {
    const shown = choicesDiv.classList.toggle('shown');
    toggleBtn.textContent = shown ? '▾' : '▸';
    q._expanded = shown;
  });
  // Pas de wire-up de notation : tout se passe dans la modale Éditer.
  item.querySelector('.edit').addEventListener('click', async () => {
    _returnToMissionsAfterSave = true;
    _missionsLastTab = 'n2';
    closeMissionsModal();
    await loadCurrentSceneMeta();
    openQuestModal(q.box_id, i);
  });
  item.querySelector('.del').addEventListener('click', async () => {
    if (!confirm('Supprimer cette quête (variante) ?')) return;
    const newList = allQuests.filter((_, j) => j !== i);
    await saveSceneMeta({ quests: newList });
    renderQuestsList();
    refreshQuestsOverview();
    refreshBoxQuestSelect();
  });
  return item;
}
$('quests-list-add').addEventListener('click', () => {
  _missionsLastTab = 'n2';
  _returnToMissionsAfterSave = true;
  closeMissionsModal();
  openQuestModal(state.selectedBoxId || '', -1);
});
// Legacy ghost button — référer compat.
$('quests-list-close').addEventListener('click', () => {
  closeMissionsModal();
  refreshQuestsOverview();
});

// ============ TOP-RAIL (volet rétractable + boutons-outils) =============
// Trois sortes d'outils :
//   - Outils-panneau (trace / source / module)  : ouvrent un panneau dépliable
//     dans le rail. Re-cliquer ferme le panneau (toggle).
//   - Outils-mode (frames / characters)         : ENTRENT directement dans
//     le mode interactif sur la scène, et FERMENT le rail.
//   - Outils-modale (quests)                    : ouvrent directement la
//     modale de gestion, et FERMENT le rail.
const TOOL_PANELS  = new Set(['trace', 'source', 'module']);
// 'frames' et 'characters' ouvrent un panneau ET activent un mode interactif
// (édition de cadres / édition par masque). Ils ne sont plus dans TOOL_MODES
// pour passer par le pipeline showToolPane standard.
const TOOL_MODES   = new Set();
const TOOL_MODES_INTERACTIVE = new Set(['frames', 'characters']);
const TOOL_MODALS  = new Set(['missions', 'sounds']);

function showToolPane(name) {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === name));
  document.querySelectorAll('.tool-pane').forEach(p => p.classList.toggle('shown', p.dataset.pane === name));
}

function clearActiveTool() {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tool-pane').forEach(p => p.classList.remove('shown'));
}

function openTopRail() { $('top-rail').classList.add('open'); }
function closeTopRail() { $('top-rail').classList.remove('open'); clearActiveTool(); }

// Quand on quitte la sélection courante, on sort proprement des modes
// interactifs (cadres, personnages) pour que les overlays disparaissent
// du master à l'écran. Aucune save de données ici (juste cleanup visuel).
async function _leaveCurrentInteractiveMode() {
  if (document.body.classList.contains('state-editor')) {
    try { await exitEditor(true); } catch {}
  }
  if (document.body.classList.contains('state-character')) {
    try { exitCharacterEditor(); } catch {}
  }
}

async function selectTool(name) {
  // 1. Modales (Missions / Sons) : sort des modes interactifs + ouvre la modale.
  if (TOOL_MODALS.has(name)) {
    await _leaveCurrentInteractiveMode();
    closeTopRail();
    if (name === 'missions') {
      if (!sceneState.id) {
        alert('Sauve d\'abord la scène comme module pour pouvoir gérer ses missions.');
        return;
      }
      await loadCurrentSceneMeta();
      openMissionsModal('n1');
    } else if (name === 'sounds') {
      if (!sceneState.id) {
        alert('Sauve d\'abord la scène comme module pour pouvoir choisir ses sons.');
        return;
      }
      await loadCurrentSceneMeta();
      openSoundsModal();
    }
    return;
  }

  // 2. Panneau-outil (Tracé, Source, Cadres, Personnages, Module) : toggle.
  const isActive = document.querySelector(`.tool-btn[data-tool="${name}"]`)?.classList.contains('active');
  if (isActive) {
    // Re-cliquer sur l'onglet actif ferme le rail ET sort de tout mode interactif
    closeTopRail();
    await _leaveCurrentInteractiveMode();
    return;
  }

  // Switch d'onglet : sort de tout mode interactif AVANT de changer (sinon les
  // cadres / le masque persistent à l'écran sous le nouvel onglet).
  await _leaveCurrentInteractiveMode();
  openTopRail();
  showToolPane(name);

  // 3. Pour les onglets qui ont AUSSI un mode interactif (Cadres, Personnages),
  // on active le mode après l'affichage du panneau pour que les overlays se
  // rendent correctement (image-layer/character-layer visibles).
  if (TOOL_MODES_INTERACTIVE.has(name)) {
    if (name === 'frames')     await enterEditor();
    if (name === 'characters') enterCharacterEditor();
  }
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => selectTool(btn.dataset.tool));
});

// La poignée bascule l'ouverture du rail. Si rien n'est actif, on ouvre sur
// "module" (le plus utile au quotidien : sauver le module en cours).
$('top-rail-handle').addEventListener('click', () => {
  const r = $('top-rail');
  if (r.classList.contains('open')) closeTopRail();
  else { openTopRail(); showToolPane('module'); }
});

// L'aperçu/modale des quêtes est désormais ouvert directement par selectTool.
// Pas besoin de listener intermédiaire.
function refreshQuestsOverview() { /* no-op — gardé pour compat */ }

// ============ MODE PERSONNAGES (édition par masque GPT) =================
// Workflow :
//   1. L'utilisateur trace un cadre sur le master (snap automatique à 16 px).
//   2. Un canvas de masque s'affiche par-dessus le cadre. Brosse blanche pour
//      désigner les pixels à éditer ; gomme pour retirer ; clear pour reset.
//   3. L'utilisateur écrit un prompt et clique « Générer ».
//   4. Le serveur extrait le crop, appelle gpt-image-2 avec le mask, blende le
//      résultat avec l'original (feather sur le mask) et recolle le crop dans
//      le master.jpg sans jointure visible.

// Contraintes gpt-image-2 (vérifiées dans le skill image-gen-azure) :
//   - W et H multiples de 16
//   - max(W, H) <= 3840
//   - max(W,H) / min(W,H) <= 3
//   - W * H ∈ [655_360 ; 8_294_400]
// Le clamp garantit ces 4 contraintes À TOUT MOMENT, en agrandissant
// proportionnellement (donc SANS déformation) si nécessaire.
const SNAP = 16;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_LONG = 3840;
const MAX_RATIO_CHAR = 3.0;

const charState = {
  rect: null,         // {x,y,w,h} en master coords (toujours snappés à 16)
  drawingRect: false, // en train de tracer le rectangle
  drawAnchor: null,   // {x,y} du point de départ du drag
  resizeRole: null,   // 'r' / 'b' / 'br' / 'move' / null
  resizeStart: null,  // {x,y, ox,oy,ow,oh}
  mode: 'rect',       // 'rect' | 'paint' | 'erase'
  brushSize: 40,
  isPainting: false,
  hadStrokes: false,  // au moins un coup de brosse (sécurité avant Génération)
};

function snap16(v) { return Math.max(0, Math.round(v / SNAP) * SNAP); }

function enterCharacterEditor() {
  setPhase('character');
  charState.rect = null;
  charState.mode = 'rect';
  charState.hadStrokes = false;
  $('character-layer').innerHTML = '';
  $('character-panel').classList.add('shown');
  $('character-mask-canvas').classList.remove('shown');
  $('char-prompt').value = '';
  $('char-rect-info').textContent = 'Trace un cadre sur l\'image, puis peins la zone à modifier.';
  setCharMode('rect');
  $('status').textContent = 'Mode personnage — trace un cadre puis peins la zone';
}

function exitCharacterEditor() {
  setPhase('home');
  $('character-panel').classList.remove('shown');
  $('character-mask-canvas').classList.remove('shown');
  $('character-layer').innerHTML = '';
  document.querySelectorAll('.char-handle').forEach(h => h.remove());
  charState.rect = null;
  $('status').textContent = statusText();
  loadScene();
}

$('exit-character').addEventListener('click', exitCharacterEditor);
$('char-cancel').addEventListener('click', exitCharacterEditor);

// ----- Sélecteur de mode (Cadre / Brosse / Gomme) -----
function setCharMode(mode) {
  charState.mode = mode;
  // L'état "actif" ne s'applique qu'aux 3 boutons de mode (rect/paint/erase),
  // pas aux boutons d'action (clear, exit, etc.) qui sont à côté.
  $('char-mode-rect').classList.toggle('active', mode === 'rect');
  $('char-mode-paint').classList.toggle('active', mode === 'paint');
  $('char-mode-erase').classList.toggle('active', mode === 'erase');
  // Canvas : pointer-events activés seulement en mode brosse/gomme.
  const canvas = $('character-mask-canvas');
  canvas.style.pointerEvents = (mode === 'paint' || mode === 'erase') ? 'auto' : 'none';
  // Bonus visuel : le rect SVG passe en pointillé en mode peinture pour signaler
  // que c'est verrouillé pendant qu'on brosse.
  document.body.classList.toggle('char-mode-paint', mode === 'paint' || mode === 'erase');
}
$('char-mode-rect').addEventListener('click', () => setCharMode('rect'));
$('char-mode-paint').addEventListener('click', () => { if (charState.rect) setCharMode('paint'); else alert('Trace d\'abord un cadre.'); });
$('char-mode-erase').addEventListener('click', () => { if (charState.rect) setCharMode('erase'); else alert('Trace d\'abord un cadre.'); });

$('char-brush-size').addEventListener('input', (e) => {
  charState.brushSize = parseInt(e.target.value, 10);
});
$('char-clear-mask').addEventListener('click', () => {
  const canvas = $('character-mask-canvas');
  if (canvas.width && canvas.height) {
    canvas.getContext('2d', { willReadFrequently: true }).clearRect(0, 0, canvas.width, canvas.height);
    charState.hadStrokes = false;
  }
});
$('char-clear-rect').addEventListener('click', () => {
  charState.rect = null;
  charState.hadStrokes = false;
  $('character-layer').innerHTML = '';
  document.querySelectorAll('.char-handle').forEach(h => h.remove());
  $('character-mask-canvas').classList.remove('shown');
  setCharMode('rect');
  $('char-rect-info').textContent = 'Trace un cadre sur l\'image, puis peins la zone à modifier.';
});

// ----- Tracer le cadre initial (drag sur le master, premier passage) -----
// Une fois le cadre tracé, c'est uniquement les poignées qui le manipulent.
$('stage').addEventListener('mousedown', e => {
  if (state.phase !== 'character') return;
  if (charState.mode !== 'rect') return;
  // Si on a déjà un cadre, on ignore : pour le redimensionner il faut passer
  // par les poignées (sinon le user efface son rect en re-cliquant ailleurs).
  if (charState.rect) return;
  // Si on a cliqué sur une poignée, c'est elle qui gère.
  if (e.target.classList && e.target.classList.contains('char-handle')) return;
  e.preventDefault();
  e.stopPropagation();
  const p = _evtPoint(e);
  charState.drawingRect = true;
  charState.drawAnchor = { x: p.x, y: p.y };
});
$('stage').addEventListener('mousemove', e => {
  if (state.phase !== 'character' || !charState.drawingRect) return;
  const p = _evtPoint(e);
  const x0 = Math.min(charState.drawAnchor.x, p.x);
  const y0 = Math.min(charState.drawAnchor.y, p.y);
  const x1 = Math.max(charState.drawAnchor.x, p.x);
  const y1 = Math.max(charState.drawAnchor.y, p.y);
  // clampCharRect garantit toutes les contraintes gpt-image-2 (multiples de
  // 16, ratio ≤3:1, long edge ≤3840, pixels ≥ 655 360 et ≤ 8 294 400) en
  // grandissant proportionnellement si besoin.
  charState.rect = clampCharRect(snap16(x0), snap16(y0), x1 - x0, y1 - y0);
  renderCharRect();
});
document.addEventListener('mouseup', () => {
  if (charState.drawingRect) {
    charState.drawingRect = false;
    if (charState.rect) onCharRectFinalized();
  }
});

function ceil16(v) { return Math.max(SNAP, Math.ceil(v / SNAP) * SNAP); }

function clampCharRect(x, y, w, h) {
  // Garde minimale : un clic isolé (w/h ~0) doit produire un cadre valide.
  if (w < 4) w = 256;
  if (h < 4) h = 256;

  // 1. Ratio ≤ 3:1 (clamp dans les deux directions, en RÉDUISANT le côté long).
  if (w > h * MAX_RATIO_CHAR) w = h * MAX_RATIO_CHAR;
  if (h > w * MAX_RATIO_CHAR) h = w * MAX_RATIO_CHAR;

  // 2. Long edge ≤ MAX_LONG, en réduisant proportionnellement.
  const longEdge = Math.max(w, h);
  if (longEdge > MAX_LONG) {
    const f = MAX_LONG / longEdge;
    w *= f; h *= f;
  }

  // 3. Total pixels ≤ MAX_PIXELS (réduction proportionnelle).
  if (w * h > MAX_PIXELS) {
    const f = Math.sqrt(MAX_PIXELS / (w * h));
    w *= f; h *= f;
  }

  // 4. Total pixels ≥ MIN_PIXELS — c'est ICI qu'on grandit, en préservant le
  //    ratio (donc sans aucune déformation), pour que le cadre soit toujours
  //    accepté par gpt-image-2.
  if (w * h < MIN_PIXELS) {
    const f = Math.sqrt(MIN_PIXELS / (w * h));
    w *= f; h *= f;
  }

  // 5. Cap par les bornes du master (peut nous re-faire passer sous MIN_PIXELS
  //    si le master est très petit ; à ce stade c'est le mieux possible).
  if (w > MASTER_W) { const f = MASTER_W / w; w *= f; h *= f; }
  if (h > MASTER_H) { const f = MASTER_H / h; w *= f; h *= f; }

  // 6. Snap à 16 — ARRONDI VERS LE HAUT pour préserver le seuil min.
  w = Math.min(MASTER_W, ceil16(w));
  h = Math.min(MASTER_H, ceil16(h));

  // 7. Si le snap nous a remis sous MIN_PIXELS (rare, p.ex. après cap master),
  //    on grossit du côté qui a le plus de marge, par paliers de 16.
  let safety = 0;
  while (w * h < MIN_PIXELS && safety++ < 64) {
    const marginW = MASTER_W - w, marginH = MASTER_H - h;
    if (w <= h && marginW >= SNAP) w += SNAP;
    else if (marginH >= SNAP) h += SNAP;
    else if (marginW >= SNAP) w += SNAP;
    else break;
  }

  // 8. Position : snap + clamp aux bornes (le rect doit tenir dans le master).
  let nx = Math.max(0, snap16(x));
  let ny = Math.max(0, snap16(y));
  if (nx + w > MASTER_W) nx = Math.max(0, snap16(MASTER_W - w));
  if (ny + h > MASTER_H) ny = Math.max(0, snap16(MASTER_H - h));
  return { x: nx, y: ny, w, h };
}

function renderCharRect() {
  const r = charState.rect;
  // 1. Rect SVG = juste la bordure visuelle (pointer-events: none)
  const layer = $('character-layer');
  layer.innerHTML = '';
  if (!r) {
    // Aussi nettoyer les poignées HTML
    document.querySelectorAll('.char-handle').forEach(h => h.remove());
    return;
  }
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('class', 'char-rect');
  rect.setAttribute('x', r.x); rect.setAttribute('y', r.y);
  rect.setAttribute('width', r.w); rect.setAttribute('height', r.h);
  layer.appendChild(rect);

  // 2. Poignées HTML positionnées en % dans zoom-inner (taille fixe écran)
  document.querySelectorAll('.char-handle').forEach(h => h.remove());
  const zi = $('zoom-inner');
  function addHandle(role, fracX, fracY, cls) {
    const h = document.createElement('div');
    h.className = 'char-handle ' + cls;
    h.dataset.role = role;
    h.style.left = ((r.x + r.w * fracX) / MASTER_W * 100) + '%';
    h.style.top  = ((r.y + r.h * fracY) / MASTER_H * 100) + '%';
    h.addEventListener('mousedown', e => startCharDrag(e, role));
    h.addEventListener('touchstart', e => startCharDrag(e, role), { passive: false });
    zi.appendChild(h);
    return h;
  }
  addHandle('move',   0.5, 0.5, 'move');     // centre = déplacer
  addHandle('right',  1.0, 0.5, 'right');    // bord droit
  addHandle('bottom', 0.5, 1.0, 'bottom');   // bord bas
  addHandle('brc',    1.0, 1.0, 'brc');      // coin bas-droit

  $('char-rect-info').textContent =
    `Cadre ${r.w}×${r.h} px à (${r.x}, ${r.y}). Multiples de 16, ratio ${(r.w/r.h).toFixed(2)}:1.`;
  positionMaskCanvas();
}

// masterPoint() utilise editor-layer comme repère SVG. Pour le mode personnage
// on a besoin du même repère même si character-layer est utilisé.
function _evtPoint(evt) {
  const t = (evt.touches && evt.touches[0]) || evt;
  // Construire un point dans le SVG character-layer (qui partage le même
  // viewBox 2560x1440 et la même position que les autres SVGs).
  const svg = $('character-layer');
  const pt = svg.createSVGPoint();
  pt.x = t.clientX; pt.y = t.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}

function startCharDrag(e, role) {
  // Les poignées + le bouton "move" central sont TOUJOURS utilisables, peu
  // importe le sub-mode (rect/paint/erase). C'est l'UX attendue.
  e.stopPropagation();
  e.preventDefault();
  const p = _evtPoint(e);
  charState.resizeRole = role;
  charState.resizeStart = { x: p.x, y: p.y,
    ox: charState.rect.x, oy: charState.rect.y,
    ow: charState.rect.w, oh: charState.rect.h };
  document.addEventListener('mousemove', onCharDragMove);
  document.addEventListener('mouseup', endCharDrag);
  document.addEventListener('touchmove', onCharDragMove, { passive: false });
  document.addEventListener('touchend', endCharDrag);
}

function onCharDragMove(e) {
  if (!charState.resizeRole) return;
  if (e.cancelable) e.preventDefault();
  const p = _evtPoint(e);
  const dx = p.x - charState.resizeStart.x;
  const dy = p.y - charState.resizeStart.y;
  const r = charState.rect;
  if (charState.resizeRole === 'move') {
    const nx = snap16(charState.resizeStart.ox + dx);
    const ny = snap16(charState.resizeStart.oy + dy);
    charState.rect = clampCharRect(nx, ny, r.w, r.h);
  } else {
    let nw = r.w, nh = r.h;
    if (charState.resizeRole === 'right' || charState.resizeRole === 'brc') {
      nw = snap16(charState.resizeStart.ow + dx);
    }
    if (charState.resizeRole === 'bottom' || charState.resizeRole === 'brc') {
      nh = snap16(charState.resizeStart.oh + dy);
    }
    charState.rect = clampCharRect(r.x, r.y, nw, nh);
  }
  renderCharRect();
}

function endCharDrag() {
  charState.resizeRole = null;
  charState.resizeStart = null;
  document.removeEventListener('mousemove', onCharDragMove);
  document.removeEventListener('mouseup', endCharDrag);
  document.removeEventListener('touchmove', onCharDragMove);
  document.removeEventListener('touchend', endCharDrag);
}

function onCharRectFinalized() {
  // Une fois le cadre confirmé, on prépare le canvas de masque + on bascule
  // automatiquement en mode brosse pour fluidifier le workflow.
  if (!charState.rect) return;
  positionMaskCanvas();
  $('character-mask-canvas').classList.add('shown');
  setCharMode('paint');
}

// ----- Canvas du masque : positionne, redimensionne, écoute la brosse -----
function positionMaskCanvas() {
  const r = charState.rect;
  if (!r) return;
  const canvas = $('character-mask-canvas');
  // Le canvas a une taille pixel exacte (= dimensions du crop GPT) et est
  // affiché en CSS aux dimensions du rect dans l'écran.
  if (canvas.width !== r.w || canvas.height !== r.h) {
    // Ré-init seulement si dim changée (préserve les coups de pinceau)
    const oldData = (canvas.width && canvas.height)
      ? canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height) : null;
    canvas.width = r.w; canvas.height = r.h;
    if (oldData && oldData.width === r.w && oldData.height === r.h) {
      canvas.getContext('2d', { willReadFrequently: true }).putImageData(oldData, 0, 0);
    }
  }
  // Positionner en CSS exactement par-dessus le rect sur le master (en %)
  const pctX = (r.x / MASTER_W) * 100;
  const pctY = (r.y / MASTER_H) * 100;
  const pctW = (r.w / MASTER_W) * 100;
  const pctH = (r.h / MASTER_H) * 100;
  canvas.style.left = pctX + '%';
  canvas.style.top = pctY + '%';
  canvas.style.width = pctW + '%';
  canvas.style.height = pctH + '%';
}

// Convertir les coords souris -> coords pixel-canvas (puisque le canvas est
// affiché en CSS à une taille différente de sa taille pixel).
function canvasPoint(evt) {
  const canvas = $('character-mask-canvas');
  const rect = canvas.getBoundingClientRect();
  const cx = (evt.clientX - rect.left) * (canvas.width / rect.width);
  const cy = (evt.clientY - rect.top) * (canvas.height / rect.height);
  return { x: cx, y: cy };
}

(function setupBrush() {
  const canvas = $('character-mask-canvas');
  let last = null;
  canvas.addEventListener('mousedown', (e) => {
    if (state.phase !== 'character') return;
    if (charState.mode !== 'paint' && charState.mode !== 'erase') return;
    e.preventDefault();
    charState.isPainting = true;
    last = canvasPoint(e);
    paintAt(last.x, last.y);
  });
  document.addEventListener('mousemove', (e) => {
    if (!charState.isPainting) return;
    const p = canvasPoint(e);
    paintLine(last.x, last.y, p.x, p.y);
    last = p;
  });
  document.addEventListener('mouseup', () => { charState.isPainting = false; last = null; });

  function paintAt(x, y) {
    const canvas = $('character-mask-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const radius = charState.brushSize;
    // Le canvas affiche une couleur translucide (mix-blend screen) pour la viz ;
    // côté serveur on lit l'alpha ce qui détermine la zone éditée.
    if (charState.mode === 'paint') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(80, 180, 255, 0.55)';
    } else {
      // gomme : retire complètement les pixels (alpha=0)
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (charState.mode === 'paint') charState.hadStrokes = true;
  }

  function paintLine(x1, y1, x2, y2) {
    // dessine plusieurs cercles le long du segment pour un trait continu
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const step = Math.max(1, charState.brushSize / 4);
    const n = Math.ceil(dist / step);
    for (let i = 0; i <= n; i++) {
      const t = i / Math.max(1, n);
      paintAt(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
    }
  }
})();

// ----- Génération : envoie le crop+mask+prompt au backend -----
$('char-generate').addEventListener('click', async () => {
  if (!charState.rect) { alert('Trace d\'abord un cadre.'); return; }
  if (!charState.hadStrokes) { alert('Peins d\'abord la zone à modifier avec la brosse.'); return; }
  const prompt = $('char-prompt').value.trim();
  if (!prompt) { alert('Décris ce que tu veux dans la zone peinte.'); return; }

  // Génère le PNG du masque (transparent où il faut éditer, opaque ailleurs).
  // Le canvas a déjà un alpha non-nul là où l'utilisateur a peint.
  // gpt-image-2 attend : transparent = à éditer, opaque = à préserver.
  const canvas = $('character-mask-canvas');
  const w = canvas.width, h = canvas.height;
  // Construire une image alpha "édit-zones-transparentes" :
  //   alpha_out = 255 si l'utilisateur N'A PAS peint, 0 si peint.
  const src = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const dst = new ImageData(w, h);
  for (let i = 0; i < src.data.length; i += 4) {
    const userPainted = src.data[i + 3] > 8; // alpha de la peinture
    dst.data[i + 0] = 0; dst.data[i + 1] = 0; dst.data[i + 2] = 0;
    dst.data[i + 3] = userPainted ? 0 : 255;
  }
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  tmp.getContext('2d').putImageData(dst, 0, 0);
  const maskDataUrl = tmp.toDataURL('image/png');

  showOverlay({ step: 'Édition par masque (~30-60s)…', step_index: 0, total_steps: 1 });
  try {
    const r = await fetch('/api/character-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rect: charState.rect,
        mask_png_b64: maskDataUrl.split(',')[1],
        prompt,
        scene_id: sceneState.id || null,
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
    // CRUCIAL : attendre RÉELLEMENT la fin du process serveur (30-60s) avant
    // de recharger le master. Sans ce await, on rechargeait le master encore
    // non modifié et la retouche semblait n'avoir aucun effet.
    await pollUntilDone({ reloadAfter: false });
    // Recharge le master modifié (cache-bust via timestamp).
    const newSrc = `master.jpg?t=${Date.now()}`;
    await new Promise(resolve => {
      const m = $('master');
      m.onload = m.onerror = resolve;
      m.src = newSrc;
    });
    // Efface le masque pour repartir propre, mais on garde le rect en place
    // pour que l'utilisateur puisse enchaîner une autre retouche au même endroit.
    const canvas = $('character-mask-canvas');
    canvas.getContext('2d', { willReadFrequently: true }).clearRect(0, 0, canvas.width, canvas.height);
    charState.hadStrokes = false;
    $('char-rect-info').textContent =
      `✓ Modification appliquée à (${charState.rect.x},${charState.rect.y}, ${charState.rect.w}×${charState.rect.h}). Re-peins pour retoucher à nouveau.`;
  } catch (err) {
    setOverlayError(err.message);
  }
});

// ============ INIT =====================================================
(async () => {
  updateMobileMode();

  // If URL has ?scene=<id>, restore that scene's assets first.
  const sceneIdParam = getQueryParam('scene');
  if (sceneIdParam) {
    try {
      const r = await fetch(`/api/scenes/${encodeURIComponent(sceneIdParam)}/load`, { method: 'POST' });
      if (r.ok) {
        sceneState.id = sceneIdParam;
        await loadCurrentSceneMeta();
      }
    } catch {}
  }

  try {
    const s = await (await fetch('/api/status', { cache: 'no-store' })).json();
    $('prompt').value = s.prompt || DEFAULT_PROMPT;
    if (s.running) { pollUntilDone(); return; }
  } catch {
    $('prompt').value = DEFAULT_PROMPT;
  }
  await loadScene();
  refreshSceneBanner();
  updateMobileMode();
})();

// =================== SONS (modal Sons) =================================
// 7 événements de jeu × 10 alternatives synthesizers = 70 presets.
// L'auteur choisit un preset par événement ; la sélection est stockée
// dans meta.sounds = { ui_tap: 'tap_velours', ui_cta: 'cta_chime_or', ... }.
// Au jouage, play.js charge meta.sounds et appelle AccrocheSFX.playSound().
//
// La modal Sons est rendue dynamiquement (vs Missions qui est statique
// dans index.html) parce que les listes de presets dépendent de sfx.js.

function openSoundsModal() {
  if (!window.AccrocheSFX) {
    alert('Moteur audio non chargé.'); return;
  }
  const currentSounds = sceneState.meta?.sounds || {};
  const enabled = sceneState.meta?.sounds_enabled !== false; // default true
  $('sounds-enabled').checked = enabled;
  renderSoundsList(currentSounds);
  $('sounds-modal').classList.add('shown');
}
function closeSoundsModal() {
  $('sounds-modal').classList.remove('shown');
}
$('sounds-close').addEventListener('click', closeSoundsModal);
$('sounds-enabled').addEventListener('change', async () => {
  await saveSceneMeta({ sounds_enabled: $('sounds-enabled').checked });
});

function renderSoundsList(currentSounds) {
  const root = $('sounds-events-list');
  root.innerHTML = '';
  const { SOUND_EVENTS, PRESETS, previewPreset } = window.AccrocheSFX;
  SOUND_EVENTS.forEach(ev => {
    const block = document.createElement('div');
    block.className = 'sounds-event-block';
    const presets = PRESETS[ev.key] || [];
    const selectedId = currentSounds[ev.key] || ev.defaultPreset;
    const chipsHtml = presets.map(p => `
      <button class="sounds-preset-chip ${p.id === selectedId ? 'selected' : ''}"
              data-event="${ev.key}" data-preset="${p.id}">
        <span class="play" aria-hidden="true">▶</span>
        <span class="label">${escapeHtmlAttr(p.label)}</span>
      </button>
    `).join('');
    block.innerHTML = `
      <div class="sounds-event-title">${escapeHtmlAttr(ev.label)}</div>
      <div class="sounds-event-desc">${escapeHtmlAttr(ev.desc)}</div>
      <div class="sounds-presets-grid">${chipsHtml}</div>
    `;
    root.appendChild(block);
  });
  // Wire les chips : un clic = preview + sélection.
  root.querySelectorAll('.sounds-preset-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const eventKey = chip.dataset.event;
      const presetId = chip.dataset.preset;
      // 1. Preview (toujours, même si le son est désactivé au jeu)
      previewPreset(eventKey, presetId);
      // 2. Marque visuel : déselectionne les frères, sélectionne ce chip
      chip.parentElement.querySelectorAll('.sounds-preset-chip').forEach(c =>
        c.classList.remove('selected'));
      chip.classList.add('selected');
      // 3. Sauve dans meta.sounds (debounced via saveSceneMeta)
      const prev = sceneState.meta?.sounds || {};
      const next = { ...prev, [eventKey]: presetId };
      await saveSceneMeta({ sounds: next });
    });
  });
}

// Sécurité : on échappe l'HTML pour éviter une injection si un label
// contient des caractères spéciaux (présentement ils sont sûrs, mais on
// se ménage la possibilité de personnaliser plus tard).
function escapeHtmlAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

// =================== HISTORIQUE des modifications =====================
// Chaque resnap ou character_edit prend un snapshot dans
// scenes/<sid>/.history/<timestamp>/. On en garde les 10 plus récents.
// L'utilisateur peut restaurer un snapshot pour annuler une modification.
$('open-history').addEventListener('click', async () => {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  await renderHistoryList();
  $('history-modal').classList.add('shown');
  closeTopRail();
});
$('history-close').addEventListener('click', () => $('history-modal').classList.remove('shown'));

// =================== GÉNÉRATION assistée + refine prompt =============
function showGptOverlay(label) {
  const el = $('gpt-overlay');
  if (!el) return;
  $('gpt-overlay-label').textContent = label || 'GPT-5.4 travaille…';
  el.classList.add('shown');
}
function hideGptOverlay() { $('gpt-overlay')?.classList.remove('shown'); }

async function doGenerate(level) {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  const countInput = $(`gen-n${level}-count`);
  const count = Math.max(1, Math.min(20, parseInt(countInput.value || '1', 10)));
  const perBox = level === 2 ? $('gen-n2-perbox')?.checked === true : false;
  showGptOverlay(level === 1
    ? `GPT-5.4 génère ${count} question(s) d'observation…`
    : `GPT-5.4 génère ${perBox ? 'une quête par cadre' : count + ' quête(s)'}…`);
  try {
    const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ level, count, per_box: perBox }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    await loadCurrentSceneMeta();
    if (level === 1) renderQuestionsList();
    else renderQuestsList();
  } catch (e) {
    alert('Génération échouée : ' + e.message);
  } finally {
    hideGptOverlay();
  }
}

async function doRefinePrompt(level) {
  if (!confirm(`Affiner le prompt de génération du niveau ${level} ?\n\nGPT relira toutes les corrections enregistrées dans corrections_n${level}.txt et proposera une nouvelle version du prompt système. L'ancienne version sera archivée.`)) return;
  showGptOverlay('GPT-5.4 relit les corrections + affine le prompt…');
  try {
    const r = await fetch('/api/refine-prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ level }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    alert(`✓ Prompt niveau ${level} mis à jour (${j.new_prompt_chars} caractères, ${j.corrections_used} corrections utilisées).\nL'ancienne version a été archivée.`);
  } catch (e) {
    alert('Affinage échoué : ' + e.message);
  } finally {
    hideGptOverlay();
  }
}

$('gen-n1')?.addEventListener('click', () => doGenerate(1));
$('gen-n2')?.addEventListener('click', () => doGenerate(2));
$('refine-n1')?.addEventListener('click', () => doRefinePrompt(1));
$('refine-n2')?.addEventListener('click', () => doRefinePrompt(2));

// ─── Modale « Régénérer pour tous les cadres » ──────────────────────
// Permet de relancer en lot N'IMPORTE QUELLE combinaison d'actions
// (image zoom 1, image zoom 2, dessin, analyse vision) sur le ou les
// cadres choisis. Le serveur a un mutex _running, donc l'exécution est
// SÉQUENTIELLE côté client : on attend chaque cadre avant le suivant.
function openRegenAllModal() {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  const boxes = sceneState.meta?.boxes || [];
  if (!boxes.length) { alert('Aucun cadre dans cette scène.'); return; }
  const list = $('ra-boxes-list');
  list.innerHTML = '';
  for (const b of boxes) {
    const bid = String(b.id);
    const hasAnalysis = !!(b._analysis && (b._analysis.personnages?.length || b._description));
    const subj = (b.subject || '').trim() || '(sans sujet)';
    const status = hasAnalysis
      ? '<span style="color:rgba(80,227,164,0.85);font-size:11px;">👁 ✓ analysé</span>'
      : '<span style="color:rgba(255,184,77,0.85);font-size:11px;">👁 ⚠ pas d\'analyse</span>';
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:6px;cursor:pointer;';
    row.innerHTML = `
      <input type="checkbox" class="ra-box-cb" data-bid="${escapeHtmlAttr(bid)}" data-has-vision="${hasAnalysis ? '1' : '0'}" checked>
      <span style="flex:1;font-size:13px;">
        <strong style="color:rgba(212,184,122,0.95);">Cadre ${escapeHtmlAttr(bid)}</strong>
        · <span style="color:rgba(255,255,255,0.85);">${escapeHtmlAttr(subj)}</span>
      </span>
      ${status}
    `;
    list.appendChild(row);
  }
  $('ra-force-vision').checked = false;
  $('regen-all-modal').classList.add('shown');
}
function closeRegenAllModal() {
  $('regen-all-modal').classList.remove('shown');
}
function _raCheckboxes() {
  return Array.from(document.querySelectorAll('#ra-boxes-list .ra-box-cb'));
}
$('ra-all')?.addEventListener('click', () => {
  _raCheckboxes().forEach(cb => { cb.checked = true; });
});
$('ra-none')?.addEventListener('click', () => {
  _raCheckboxes().forEach(cb => { cb.checked = false; });
});
$('ra-missing-vision')?.addEventListener('click', () => {
  _raCheckboxes().forEach(cb => { cb.checked = cb.dataset.hasVision !== '1'; });
});
$('regen-all-cancel')?.addEventListener('click', closeRegenAllModal);
$('regen-all-modal')?.addEventListener('click', (e) => {
  if (e.target === $('regen-all-modal')) closeRegenAllModal();
});

$('ra-launch')?.addEventListener('click', async () => {
  const selected = _raCheckboxes().filter(cb => cb.checked).map(cb => cb.dataset.bid);
  if (!selected.length) { alert('Coche au moins un cadre.'); return; }
  const opts = {
    imageB: $('ra-imageB').checked,
    imageC: $('ra-imageC').checked,
    dessin: $('ra-dessin').checked,
  };
  const wantVision = $('ra-vision').checked;
  if (!opts.imageB && !opts.imageC && !opts.dessin && !wantVision) {
    alert('Coche au moins une action à régénérer.');
    return;
  }
  const force = $('ra-force-vision').checked;
  closeRegenAllModal();

  // Map id → box pour les appels /api/regen-box (qui exige le payload box)
  const boxById = Object.fromEntries(
    (sceneState.meta?.boxes || []).map(b => [String(b.id), b])
  );

  const wantImageOps = opts.imageB || opts.imageC || opts.dessin;
  let done = 0, errors = [];
  for (const bid of selected) {
    done++;
    const box = boxById[bid];
    if (!box) { errors.push(`cadre ${bid} introuvable`); continue; }
    // 1. Actions images via regen-box (séquentiel, attend la fin)
    if (wantImageOps) {
      showOverlay({
        step: `Cadre ${bid} (${done}/${selected.length}) — régénération images…`,
        step_index: done - 1, total_steps: selected.length,
      });
      try {
        const r = await fetch('/api/regen-box', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ box, opts, scene_id: sceneState.id }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { errors.push(`cadre ${bid} (images) : ${j.error || 'HTTP ' + r.status}`); }
        else { await pollUntilDone({ reloadAfter: false }); }
      } catch (e) {
        errors.push(`cadre ${bid} (images) : ${e.message}`);
      }
    }
    // 2. Vision via describe-boxes (toujours séquentiel après les images)
    if (wantVision) {
      showGptOverlay(`Cadre ${bid} (${done}/${selected.length}) — analyse vision…`);
      try {
        await _runVisionOnBoxes([String(bid)], force);
      } catch (e) {
        errors.push(`cadre ${bid} (vision) : ${e.message}`);
      } finally {
        hideGptOverlay();
      }
    }
  }
  if (errors.length) alert(`Terminé avec ${errors.length} erreur(s) :\n\n${errors.join('\n')}`);
  else alert(`✓ ${selected.length} cadre(s) régénéré(s).`);
});

$('regen-all-boxes')?.addEventListener('click', openRegenAllModal);

$('bootstrap-corpus')?.addEventListener('click', async () => {
  if (!confirm(
    'AMORÇAGE INITIAL DU CORPUS\n\n' +
    'Cette action :\n' +
    '• Marque toutes les questions N1 et quêtes N2 actuellement présentes dans tes modules comme exemples POSITIFS (good) dans le corpus de corrections.\n' +
    '• Calcule un embedding par entrée et écrit dans corrections_n{1,2}.jsonl.\n\n' +
    "C'est un point de départ. Par la suite, à chaque clic ★/✦/✗ dans Missions ou dans le quest-modal :\n" +
    '• ★ → entrée GOOD enrichit les BONNES PRATIQUES\n' +
    '• ✦ → entrée NUANCED enrichit les ANTI-PATTERNS (à nuancer)\n' +
    '• ✗ → entrée REFUSED enrichit les ANTI-PATTERNS (à éviter)\n\n' +
    'Le RAG injectera ensuite les deux types à chaque génération.\n\n' +
    'Idempotent : les items déjà amorcés sont ignorés.'
  )) return;
  showGptOverlay('Calcul des embeddings et écriture des corrections…');
  try {
    const r = await fetch('/api/bootstrap-corpus', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    const lines = Object.entries(j.report || {}).map(([sid, r]) =>
      `· ${sid} : ${r.n1_added} questions N1 + ${r.n2_added} quêtes N2`).join('\n');
    alert(`✓ Corpus RAG amorcé\n\n${lines || '(rien à ajouter)'}`);
  } catch (e) {
    alert('Bootstrap échoué : ' + e.message);
  } finally {
    hideGptOverlay();
  }
});

async function renderHistoryList() {
  const root = $('history-list');
  root.innerHTML = '<div class="history-empty">Chargement…</div>';
  let history = [];
  try {
    const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/history`, { cache: 'no-store' });
    const j = await r.json();
    history = j.history || [];
  } catch {}
  if (!history.length) {
    root.innerHTML = '<div class="history-empty">Aucun snapshot d\'historique encore. Modifie le master ou les tracés pour en créer un.</div>';
    return;
  }
  root.innerHTML = '';
  history.forEach(snap => {
    const item = document.createElement('div');
    item.className = 'history-item';
    // Résumé : nombre de fichiers + premiers types
    const types = new Set();
    (snap.files || []).forEach(f => {
      if (f.startsWith('master.')) types.add('master');
      else if (f.startsWith('lineart-svg/')) types.add('tracés');
      else if (f.startsWith('exp3/imageB/')) types.add('zoom 1');
      else if (f.startsWith('exp3/imageC/')) types.add('zoom 2');
      else if (f === 'boxes.json') types.add('cadres');
    });
    const typesStr = [...types].join(' · ') || 'fichiers';
    item.innerHTML = `
      <div class="meta">
        <div class="ts">${escapeHtmlAttr(snap.label)}</div>
        <div class="files">${escapeHtmlAttr(typesStr)} · ${snap.files.length} fichier${snap.files.length>1?'s':''}</div>
      </div>
      <button class="restore-btn" data-ts="${snap.timestamp}">↶ Restaurer</button>
    `;
    item.querySelector('.restore-btn').addEventListener('click', async () => {
      if (!confirm(`Restaurer l'état du module au ${snap.label} ?\nL'état actuel sera également snapshoté pour pouvoir annuler.`)) return;
      const r = await fetch(`/api/scenes/${encodeURIComponent(sceneState.id)}/history/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: snap.timestamp }),
      });
      if (!r.ok) { alert('Restauration échouée.'); return; }
      $('history-modal').classList.remove('shown');
      // Recharge entièrement la scène pour voir le master/lineart/imageB restaurés.
      await loadScene();
      await loadCurrentSceneMeta();
      alert('Module restauré. Recharge la page si certains caches d\'image persistent.');
    });
    root.appendChild(item);
  });
}
