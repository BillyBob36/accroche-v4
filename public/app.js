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
$('regen-box').addEventListener('click', async () => {
  if (!state.selectedBoxId) { alert('Sélectionne un cadre.'); return; }
  const opts = {
    imageB: $('regen-imageB').checked,
    imageC: $('regen-imageC').checked,
    dessin: $('regen-dessin').checked,
  };
  if (!opts.imageB && !opts.imageC && !opts.dessin) {
    alert('Coche au moins une option à régénérer.');
    return;
  }
  const box = state.boxes.find(b => String(b.id) === String(state.selectedBoxId));
  if (!box) return;
  // Save current edits to box (subject/aspect/x/y/w/h) before regenerating.
  await saveBoxes();
  showOverlay({ step: `Régénération du cadre ${box.id}…`, step_index: 0, total_steps: 1 });
  try {
    const r = await fetch('/api/regen-box', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ box, opts, scene_id: sceneState.id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setOverlayError(j.error || `HTTP ${r.status}`); return; }
    pollUntilDone({ reloadAfter: false });
  } catch (err) {
    setOverlayError(err.message);
  }
});

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

// Glow slider — soft drop-shadow on the active skel-group as a whole.
(() => {
  const root = document.documentElement;
  const inp = $('glow'), val = $('glow-val');
  function apply(v) {
    const f = Number(v);
    val.textContent = f.toFixed(2);
    root.style.setProperty('--glow-r', `${(f * 18).toFixed(1)}px`);
    root.style.setProperty('--glow-a', (f * 0.95).toFixed(3));
    document.body.classList.toggle('no-glow', f === 0);
    localStorage.setItem('accroche-glow', v);
  }
  const saved = localStorage.getItem('accroche-glow');
  if (saved !== null) inp.value = saved;
  apply(inp.value);
  inp.addEventListener('input', e => apply(e.target.value));
})();

// Stroke-width slider — controls how thick the contour appears.
(() => {
  const root = document.documentElement;
  const inp = $('stroke'), val = $('stroke-val');
  function apply(v) {
    val.textContent = Number(v).toFixed(1);
    root.style.setProperty('--stroke-w', v);
    localStorage.setItem('accroche-stroke', v);
  }
  const saved = localStorage.getItem('accroche-stroke');
  if (saved !== null) inp.value = saved;
  apply(inp.value);
  inp.addEventListener('input', e => apply(e.target.value));
})();

// Stroke-opacity slider — slight transparency on the contour for a softer look.
(() => {
  const root = document.documentElement;
  const inp = $('opacity'), val = $('opacity-val');
  function apply(v) {
    val.textContent = Number(v).toFixed(2);
    root.style.setProperty('--stroke-opacity', v);
    localStorage.setItem('accroche-opacity', v);
  }
  const saved = localStorage.getItem('accroche-opacity');
  if (saved !== null) inp.value = saved;
  apply(inp.value);
  inp.addEventListener('input', e => apply(e.target.value));
})();

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
  closeQuestionModal();
  if ($('questions-list-modal').classList.contains('shown')) renderQuestionsList();
});

function renderQuestionsList() {
  const box = $('ql-items');
  box.innerHTML = '';
  const list = sceneState.meta?.level1_questions || [];
  if (!list.length) {
    box.innerHTML = '<div style="color:rgba(255,255,255,0.45);font-size:12px;padding:12px;text-align:center;">Aucune question — clique sur « + Ajouter ».</div>';
    return;
  }
  list.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'ql-item';
    item.innerHTML = `
      <div class="ql-text"><strong>${i + 1}.</strong> ${q.text}</div>
      <div class="ql-actions">
        <button class="edit">Éditer</button>
        <button class="del">Suppr</button>
      </div>`;
    item.querySelector('.edit').addEventListener('click', () => {
      $('questions-list-modal').classList.remove('shown');
      openQuestionModal(i);
    });
    item.querySelector('.del').addEventListener('click', async () => {
      if (!confirm('Supprimer cette question ?')) return;
      const newList = list.filter((_, j) => j !== i);
      await saveSceneMeta({ level1_questions: newList });
      renderQuestionsList();
    });
    box.appendChild(item);
  });
}

$('add-observation-question').addEventListener('click', async () => {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  await loadCurrentSceneMeta();
  openQuestionModal(-1);
});
$('manage-questions').addEventListener('click', async () => {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  await loadCurrentSceneMeta();
  renderQuestionsList();
  $('questions-list-modal').classList.add('shown');
});
$('ql-add').addEventListener('click', () => {
  $('questions-list-modal').classList.remove('shown');
  openQuestionModal(-1);
});
$('ql-close').addEventListener('click', () => $('questions-list-modal').classList.remove('shown'));

// =================== QUESTS (level 2) ==================================
let editingQuestIndex = -1;
let editingQuestBoxId = null;

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
  choices.forEach((c, i) => {
    const row = addChoiceRow(cbox, c.text || '', i === bestIdx, true);
    if (c.explanation) row.querySelector('textarea').value = c.explanation;
  });
  $('quest-modal').classList.add('shown');
}

function closeQuestModal() {
  $('quest-modal').classList.remove('shown');
  editingQuestIndex = -1;
  editingQuestBoxId = null;
}

$('qu-add-choice').addEventListener('click', () => addChoiceRow($('qu-choices'), '', false, true));
$('qu-cancel').addEventListener('click', closeQuestModal);

async function saveQuest() {
  if (!sceneState.id) { alert('Sauve d\'abord la scène comme module.'); return; }
  const title = $('qu-title').value.trim();
  const intro = $('qu-intro').value.trim();
  const boxIdSel = $('qu-box').value.trim();
  const { choices, correctIdx } = readChoices($('qu-choices'), true);
  if (!boxIdSel) { alert('Choisis un cadre associé pour cette quête.'); return; }
  if (!title) { alert('Titre manquant.'); return; }
  if (choices.length < 2) { alert('Au moins 2 choix de dialogue.'); return; }
  const dialogue_choices = choices.map((c, i) => ({
    text: c.text, explanation: c.explanation, is_best: i === correctIdx,
  }));
  const id = editingQuestIndex >= 0
    ? sceneState.meta.quests[editingQuestIndex].id
    : 'quest-' + Date.now();
  // Les images viennent désormais du cadre (imageB pour image1, imageC pour image2).
  // Plus besoin de stocker des prompts par quête — c'est le cadre qui pilote.
  const quest = {
    id, box_id: String(boxIdSel),
    title, intro_text: intro,
    dialogue_choices,
  };
  const list = [...(sceneState.meta?.quests || [])];
  if (editingQuestIndex >= 0) list[editingQuestIndex] = quest;
  else list.push(quest);
  await saveSceneMeta({ quests: list });
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

// Modale-liste de toutes les quêtes (vue dédiée du module "Quêtes")
function openQuestsListModal() {
  $('quests-list-modal').classList.add('shown');
  renderQuestsList();
}
function renderQuestsList() {
  const box = $('quests-list-items');
  box.innerHTML = '';
  const quests = sceneState.meta?.quests || [];
  if (!quests.length) {
    box.innerHTML = '<div style="color:rgba(255,255,255,0.45);font-size:12px;padding:12px;text-align:center;">Aucune quête. Clique sur « + Nouvelle quête ».</div>';
    return;
  }
  quests.forEach((q, i) => {
    const item = document.createElement('div');
    item.className = 'ql-item';
    const hasImgs = q._has_images ? '<span style="color:rgba(80,227,164,0.85);">✓ images</span>' : '<span style="color:rgba(255,184,77,0.85);">⚠ images manquantes</span>';
    item.innerHTML = `
      <div class="ql-text">
        <strong>${q.title || 'Quête'}</strong>
        <span style="color:rgba(255,255,255,0.5);font-size:11px;margin-left:6px;">cadre ${q.box_id || '—'}</span>
        <div style="font-size:11px;margin-top:3px;">${hasImgs}</div>
      </div>
      <div class="ql-actions">
        <button class="edit">Éditer</button>
        <button class="regen" title="Régénérer les 2 images">↻</button>
        <button class="del">Suppr</button>
      </div>`;
    item.querySelector('.edit').addEventListener('click', async () => {
      $('quests-list-modal').classList.remove('shown');
      await loadCurrentSceneMeta();
      openQuestModal(q.box_id, i);
    });
    item.querySelector('.regen').addEventListener('click', async () => {
      // Les images de la quête viennent du cadre lié (imageB + imageC).
      // « Régénérer » revient donc à régénérer ces deux images du cadre.
      const linkedBox = state.boxes.find(b => String(b.id) === String(q.box_id));
      if (!linkedBox) { alert('Le cadre lié à cette quête n\'existe plus.'); return; }
      if (!confirm(`Relancer la génération des images zoom du cadre ${q.box_id} (image B + image C) ?`)) return;
      $('quests-list-modal').classList.remove('shown');
      showOverlay({ step: 'Régénération des 2 images du cadre…', step_index: 1, total_steps: 2 });
      const r = await fetch('/api/regen-box', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          box: linkedBox,
          opts: { imageB: true, imageC: true, dessin: false },
          scene_id: sceneState.id,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setOverlayError(j.error || 'erreur génération'); return;
      }
      pollUntilDone({ reloadAfter: false });
    });
    item.querySelector('.del').addEventListener('click', async () => {
      if (!confirm('Supprimer cette quête ?')) return;
      const newList = quests.filter((_, j) => j !== i);
      await saveSceneMeta({ quests: newList });
      renderQuestsList();
      refreshQuestsOverview();
      refreshBoxQuestSelect();
    });
    box.appendChild(item);
  });
}
$('quests-list-add').addEventListener('click', () => {
  $('quests-list-modal').classList.remove('shown');
  // Ouvre la modale d'édition vierge (le user choisit le cadre dans le select).
  openQuestModal(state.selectedBoxId || '', -1);
});
$('quests-list-close').addEventListener('click', () => {
  $('quests-list-modal').classList.remove('shown');
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
const TOOL_MODES   = new Set(['frames', 'characters']);
const TOOL_MODALS  = new Set(['quests']);

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

async function selectTool(name) {
  if (TOOL_MODES.has(name)) {
    closeTopRail();
    if (name === 'frames')     await enterEditor();
    if (name === 'characters') enterCharacterEditor();
    return;
  }
  if (TOOL_MODALS.has(name)) {
    closeTopRail();
    if (name === 'quests') {
      if (!sceneState.id) {
        alert('Sauve d\'abord la scène comme module pour pouvoir gérer ses quêtes.');
        return;
      }
      await loadCurrentSceneMeta();
      openQuestsListModal();
    }
    return;
  }
  // Outil-panneau : toggle. Re-cliquer sur le bouton actif ferme le rail.
  // Cliquer sur un autre bouton-panneau bascule vers ce panneau.
  const isActive = document.querySelector(`.tool-btn[data-tool="${name}"]`)?.classList.contains('active');
  if (isActive) {
    closeTopRail();
  } else {
    openTopRail();
    showToolPane(name);
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
