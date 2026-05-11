'use strict';

// ===================================================================
//   Accroche · Sound Engine
//
//   Synthétiseur Web Audio API embarqué. Chaque "preset" est un objet
//   décrivant comment générer un son à la volée (oscillateurs +
//   enveloppes + filtres). Aucun fichier externe — tout est synthétisé
//   au moment du jeu, ce qui garantit zéro latence, zéro CDN, zéro
//   dépendance.
//
//   Architecture :
//   - SoundEngine : initialise un AudioContext partagé.
//   - PRESETS : par événement, 10 alternatives (variations timbre/
//     hauteur/durée) que l'auteur peut auditionner et choisir dans
//     l'éditeur.
//   - SOUND_EVENTS : liste maître des slots — UI clicks, validations,
//     transitions, etc. Chacun a un labelFR pour l'éditeur.
//   - playSound(eventKey, presetId) : joue le preset choisi pour cet
//     événement. Si pas de preset choisi, joue le default (premier de
//     la liste).
//
//   Design sound : pour cette première itération, j'ai composé les
//   presets pour évoquer le velours-théâtre : timbres chauds, harmonies
//   feutrées, attaques douces, jamais agressif. Inspirations : Apple
//   chimes (clarté), Maison Margiela boutique (sobriété), Westminster
//   bells (élégance), Foley feutre (texture).
// ===================================================================

(function (global) {

  // ---------- AudioContext singleton ----------
  // `_audioCtxOverride` permet à `renderReversed()` de rediriger temporairement
  // tous les nouveaux nodes vers un OfflineAudioContext (rendu hors-ligne)
  // pour pré-render un preset → reverse → re-play. Tous les builders appellent
  // ctx() pour obtenir leur contexte, donc cette redirection est transparente.
  let _ctx = null;
  let _audioCtxOverride = null;
  function ctx() {
    if (_audioCtxOverride) return _audioCtxOverride;
    if (!_ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _ctx = new AC();
    }
    // Safari/iOS : l'AudioContext démarre suspendu ; tout premier event user
    // le réveille. On essaie un resume() opportuniste.
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {});
    return _ctx;
  }

  // ---------- Helpers d'enveloppe ADSR ----------
  function envelope(gain, t0, dur, a = 0.005, d = 0.05, s = 0.5, r = 0.2, peak = 1.0) {
    const t1 = t0 + a;
    const t2 = t1 + d;
    const t3 = t0 + dur;
    const t4 = t3 + r;
    gain.gain.cancelScheduledValues(t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t1);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t2);
    gain.gain.setValueAtTime(Math.max(0.0001, peak * s), t3);
    gain.gain.exponentialRampToValueAtTime(0.0001, t4);
    return t4;
  }

  // Bruit blanc 1 seconde — réutilisable pour whoosh/silk
  let _noiseBuffer = null;
  function noiseBuffer() {
    if (_noiseBuffer) return _noiseBuffer;
    const c = ctx(); if (!c) return null;
    const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    _noiseBuffer = buf;
    return buf;
  }

  // ---------- Builders de presets ----------
  // Chacun reçoit le ctx et le destination node, renvoie une fonction
  // play(volume) qui déclenche le son immédiatement.

  /** Pulse-tone : oscillateur unique avec enveloppe courte. */
  function pulseTone({ freq = 800, type = 'sine', dur = 0.08, a = 0.002, r = 0.06, filter = null }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      let node = osc;
      if (filter) {
        const flt = c.createBiquadFilter();
        flt.type = filter.type || 'lowpass';
        flt.frequency.value = filter.freq || 1200;
        flt.Q.value = filter.q || 1;
        node.connect(flt);
        node = flt;
      }
      node.connect(g);
      g.connect(c.destination);
      envelope(g, now, dur, a, 0.01, 0.6, r, vol * 0.35);
      osc.start(now);
      osc.stop(now + dur + r + 0.05);
    };
  }

  /** Bell-chime : 2-3 partiels de cloche, attaque rapide, longue queue. */
  function bellChime({ freqs = [880, 1320, 1760], dur = 0.6, ratios = [1, 0.5, 0.25], detune = 0 }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      freqs.forEach((f, i) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        osc.detune.value = detune;
        osc.connect(g);
        g.connect(c.destination);
        envelope(g, now, dur * (1 - i * 0.05), 0.003, 0.04, 0.001, dur, vol * 0.22 * (ratios[i] || 0.3));
        osc.start(now);
        osc.stop(now + dur + 0.2);
      });
    };
  }

  /** Soft-whoosh : bruit + filtre passe-bas qui sweep. */
  function softWhoosh({ dur = 0.45, fromHz = 200, toHz = 1800, hp = false }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer();
      src.loop = true;
      const flt = c.createBiquadFilter();
      flt.type = hp ? 'highpass' : 'lowpass';
      flt.frequency.value = fromHz;
      flt.frequency.linearRampToValueAtTime(toHz, now + dur);
      flt.Q.value = 1.5;
      const g = c.createGain();
      src.connect(flt); flt.connect(g); g.connect(c.destination);
      envelope(g, now, dur, 0.04, 0.04, 0.6, 0.15, vol * 0.22);
      src.start(now);
      src.stop(now + dur + 0.2);
    };
  }

  /** Air-blade : bruit + bandpass ÉTROIT qui sweep → effet lame / flèche
      / sifflement aérien. Plus le Q est haut, plus le son devient
      "sifflet" et focalisé. Idéal pour les "coups qui fendent l'air". */
  function airBlade({ dur = 0.4, fromHz = 600, toHz = 1800, q = 6, peak = 0.32 }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer();
      src.loop = true;
      const flt = c.createBiquadFilter();
      flt.type = 'bandpass';
      flt.frequency.value = fromHz;
      flt.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), now + dur);
      flt.Q.value = q;
      const g = c.createGain();
      src.connect(flt); flt.connect(g); g.connect(c.destination);
      envelope(g, now, dur, 0.02, 0.05, 0.7, 0.12, vol * peak);
      src.start(now);
      src.stop(now + dur + 0.2);
    };
  }

  /** Punch-miss : whoosh avec attaque MARQUÉE et decay rapide. Le filtre
      lowpass descend (object qui s'éloigne ou poing qui rate). Simule
      le bruit d'air déplacé violemment. */
  function airPunchMiss({ dur = 0.35, fromHz = 1400, toHz = 200, peak = 0.42 }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer();
      src.loop = true;
      const flt = c.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = fromHz;
      flt.frequency.exponentialRampToValueAtTime(Math.max(40, toHz), now + dur);
      flt.Q.value = 1.5;
      const g = c.createGain();
      src.connect(flt); flt.connect(g); g.connect(c.destination);
      // Attack très rapide + decay long → caractère "coup raté"
      envelope(g, now, dur * 0.35, 0.005, 0.04, 0.45, dur * 0.65, vol * peak);
      src.start(now);
      src.stop(now + dur + 0.2);
    };
  }

  /** Arpeggio : N notes successives (montée ou descente). */
  function arpeggio({ freqs = [523, 659, 784], step = 0.08, dur = 0.18, type = 'triangle' }) {
    return (vol = 1) => {
      const c = ctx(); if (!c) return;
      const now = c.currentTime;
      freqs.forEach((f, i) => {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = type;
        osc.frequency.value = f;
        osc.connect(g);
        g.connect(c.destination);
        envelope(g, now + i * step, dur, 0.005, 0.05, 0.5, 0.12, vol * 0.28);
        osc.start(now + i * step);
        osc.stop(now + i * step + dur + 0.15);
      });
    };
  }

  /** Tick discret : pulse très courte, sec. */
  function tick({ freq = 1500, dur = 0.025 }) {
    return pulseTone({ freq, type: 'square', dur, a: 0.001, r: 0.015,
      filter: { type: 'bandpass', freq, q: 4 } });
  }

  /** Soft-knock : impact bois feutré. Oscillator + filtre passe-bas. */
  function softKnock({ freq = 220, dur = 0.12 }) {
    return pulseTone({ freq, type: 'triangle', dur, a: 0.001, r: 0.08,
      filter: { type: 'lowpass', freq: freq * 4, q: 2 } });
  }

  // ---------- PRESETS : 10 alternatives par événement ----------
  //
  // Chaque preset a un id stable, un label FR humain, et une fonction
  // build() qui renvoie le player(volume).
  //
  // Pour les noms des presets, j'ai pris la liberté de styler à la
  // boutique de joaillerie pour rester dans l'univers velours-théâtre.

  const PRESETS = {

    // ============== UI : tap subtil (boutons secondaires, dots) ==============
    ui_tap: [
      { id: 'tap_satin',    label: 'Satin', build: () => pulseTone({ freq: 1400, type: 'sine', dur: 0.04, a: 0.001, r: 0.03 }) },
      { id: 'tap_bois',     label: 'Bois ciré', build: () => softKnock({ freq: 320, dur: 0.07 }) },
      { id: 'tap_cristal',  label: 'Cristal léger', build: () => bellChime({ freqs: [2200, 3300], dur: 0.18, ratios: [1, 0.3] }) },
      { id: 'tap_perle',    label: 'Perle nacrée', build: () => pulseTone({ freq: 2400, type: 'sine', dur: 0.06, a: 0.001, r: 0.05, filter: { type: 'bandpass', freq: 2400, q: 8 } }) },
      { id: 'tap_ivoire',   label: 'Ivoire poli', build: () => softKnock({ freq: 480, dur: 0.05 }) },
      { id: 'tap_clic_or',  label: 'Clic or', build: () => pulseTone({ freq: 1800, type: 'triangle', dur: 0.05, a: 0.001, r: 0.04 }) },
      { id: 'tap_chuchote', label: 'Chuchoté', build: () => softWhoosh({ dur: 0.10, fromHz: 1200, toHz: 4000, hp: true }) },
      { id: 'tap_diapason', label: 'Diapason court', build: () => pulseTone({ freq: 880, type: 'sine', dur: 0.10, a: 0.002, r: 0.08 }) },
      { id: 'tap_velours',  label: 'Velours', build: () => pulseTone({ freq: 380, type: 'sine', dur: 0.06, a: 0.005, r: 0.05, filter: { type: 'lowpass', freq: 1200, q: 1 } }) },
      { id: 'tap_silence',  label: '— Silence —', build: () => () => {} },
    ],

    // ============== UI : CTA primaire (bouton or) ==============
    ui_cta: [
      { id: 'cta_chime_or',     label: 'Chime or', build: () => bellChime({ freqs: [880, 1318], dur: 0.45, ratios: [1, 0.5] }) },
      { id: 'cta_velours_doux', label: 'Velours doux', build: () => arpeggio({ freqs: [523, 698], step: 0.06, dur: 0.16, type: 'sine' }) },
      { id: 'cta_perle_double', label: 'Perle double', build: () => arpeggio({ freqs: [1320, 1980], step: 0.05, dur: 0.18, type: 'triangle' }) },
      { id: 'cta_rideau',       label: 'Rideau qui s\'ouvre', build: () => softWhoosh({ dur: 0.55, fromHz: 200, toHz: 1200 }) },
      { id: 'cta_chime_haut',   label: 'Chime aigu', build: () => bellChime({ freqs: [1318, 1976, 2637], dur: 0.5, ratios: [1, 0.4, 0.15] }) },
      { id: 'cta_chime_bas',    label: 'Chime grave', build: () => bellChime({ freqs: [440, 660, 880], dur: 0.55, ratios: [1, 0.45, 0.2] }) },
      { id: 'cta_satin_dbl',    label: 'Satin double', build: () => arpeggio({ freqs: [1568, 1864], step: 0.05, dur: 0.14, type: 'sine' }) },
      { id: 'cta_or_solide',    label: 'Or solide', build: () => pulseTone({ freq: 1046, type: 'triangle', dur: 0.28, a: 0.005, r: 0.22 }) },
      { id: 'cta_porte_velours',label: 'Porte velours', build: () => softWhoosh({ dur: 0.45, fromHz: 300, toHz: 800 }) },
      { id: 'cta_silence',      label: '— Silence —', build: () => () => {} },
    ],

    // ============== Validation : bonne réponse (QCM / dialogue best) ==============
    validate_good: [
      { id: 'good_acte',        label: 'Acte juste', build: () => arpeggio({ freqs: [523, 659, 784], step: 0.07, dur: 0.22, type: 'sine' }) },
      { id: 'good_arpeggio_or', label: 'Arpège or', build: () => arpeggio({ freqs: [659, 880, 1175], step: 0.08, dur: 0.24, type: 'triangle' }) },
      { id: 'good_chime_long',  label: 'Chime long', build: () => bellChime({ freqs: [1318, 1976, 2637], dur: 0.8, ratios: [1, 0.5, 0.25] }) },
      { id: 'good_velours_haut',label: 'Velours haut', build: () => arpeggio({ freqs: [880, 1175, 1568], step: 0.06, dur: 0.20, type: 'sine' }) },
      { id: 'good_succ_perle',  label: 'Succès perlé', build: () => arpeggio({ freqs: [1568, 1864, 2349], step: 0.04, dur: 0.18, type: 'triangle' }) },
      { id: 'good_curtain_rise',label: 'Lever de rideau', build: () => softWhoosh({ dur: 0.7, fromHz: 200, toHz: 1600 }) },
      { id: 'good_warm_chime',  label: 'Chime chaud', build: () => bellChime({ freqs: [659, 988], dur: 0.65, ratios: [1, 0.4] }) },
      { id: 'good_west_short',  label: 'Westminster court', build: () => arpeggio({ freqs: [659, 523, 587, 392], step: 0.18, dur: 0.4, type: 'sine' }) },
      { id: 'good_or_pur',      label: 'Or pur', build: () => bellChime({ freqs: [1046, 1568], dur: 0.7, ratios: [1, 0.45] }) },
      { id: 'good_silence',     label: '— Silence —', build: () => () => {} },
    ],

    // ============== Validation : mauvaise réponse / choix discutable ==============
    validate_bad: [
      { id: 'bad_velours_grave', label: 'Velours grave', build: () => pulseTone({ freq: 220, type: 'sine', dur: 0.35, a: 0.01, r: 0.25, filter: { type: 'lowpass', freq: 600, q: 1 } }) },
      { id: 'bad_arpeggio_bas',  label: 'Arpège descendant', build: () => arpeggio({ freqs: [392, 311, 247], step: 0.10, dur: 0.20, type: 'sine' }) },
      { id: 'bad_souffle',       label: 'Souffle bas', build: () => softWhoosh({ dur: 0.55, fromHz: 1200, toHz: 200 }) },
      { id: 'bad_note_seule',    label: 'Note seule grave', build: () => pulseTone({ freq: 165, type: 'triangle', dur: 0.45, a: 0.01, r: 0.3 }) },
      { id: 'bad_minor_pair',    label: 'Mineur double', build: () => arpeggio({ freqs: [466, 311], step: 0.08, dur: 0.25, type: 'sine' }) },
      { id: 'bad_curtain_close', label: 'Rideau qui tombe', build: () => softWhoosh({ dur: 0.5, fromHz: 1200, toHz: 100 }) },
      { id: 'bad_chime_voile',   label: 'Chime voilé', build: () => bellChime({ freqs: [311, 466], dur: 0.45, ratios: [1, 0.5] }) },
      { id: 'bad_pulse_warm',    label: 'Pulse chaud bas', build: () => pulseTone({ freq: 260, type: 'sine', dur: 0.28, a: 0.005, r: 0.22 }) },
      { id: 'bad_neutre',        label: 'Neutre suspendu', build: () => bellChime({ freqs: [415, 622], dur: 0.5, ratios: [1, 0.4] }) },
      { id: 'bad_silence',       label: '— Silence —', build: () => () => {} },
    ],

    // ============== Zoom in : famille « coup de vent / coup raté » ==========
    // Sons aériens qui évoquent un déplacement rapide d'air. Mix de :
    //   - whooshes graves (vent/bourrasque, lowpass)
    //   - lames bandpass (sifflement focalisé)
    //   - coups ratés (attaque marquée + decay)
    zoom_in: [
      { id: 'zoom_coup_vent',   label: 'Coup de vent', build: () => softWhoosh({ dur: 0.85, fromHz: 200, toHz: 1400 }) },
      { id: 'zoom_coup_rate',   label: 'Coup raté (rapide)', build: () => airPunchMiss({ dur: 0.30, fromHz: 1600, toHz: 200 }) },
      { id: 'zoom_lame_air',    label: 'Lame qui fend l\'air', build: () => airBlade({ dur: 0.45, fromHz: 350, toHz: 1900, q: 6 }) },
      { id: 'zoom_bourrasque',  label: 'Bourrasque', build: () => softWhoosh({ dur: 1.30, fromHz: 80, toHz: 900 }) },
      { id: 'zoom_cape',        label: 'Cape qui claque', build: () => airPunchMiss({ dur: 0.55, fromHz: 1000, toHz: 300, peak: 0.38 }) },
      { id: 'zoom_cyclone',     label: 'Souffle de cyclone', build: () => softWhoosh({ dur: 1.50, fromHz: 60, toHz: 600 }) },
      { id: 'zoom_sabre',       label: 'Sabre court', build: () => airBlade({ dur: 0.20, fromHz: 600, toHz: 2800, q: 8 }) },
      { id: 'zoom_fleche',      label: 'Flèche qui passe', build: () => airBlade({ dur: 0.42, fromHz: 2800, toHz: 700, q: 10 }) },
      { id: 'zoom_passage_air', label: 'Passage d\'air', build: () => airPunchMiss({ dur: 0.45, fromHz: 1800, toHz: 400, peak: 0.36 }) },
      { id: 'zoom_silence',     label: '— Silence —', build: () => () => {} },
    ],

    // ============== Score reveal (les % géants apparaissent) ==============
    score_reveal: [
      { id: 'sc_fanfare',     label: 'Fanfare brève', build: () => arpeggio({ freqs: [523, 659, 784, 1046], step: 0.08, dur: 0.22, type: 'triangle' }) },
      { id: 'sc_chime_haut',  label: 'Chime haut', build: () => bellChime({ freqs: [1318, 1976, 2637], dur: 0.9, ratios: [1, 0.5, 0.25] }) },
      { id: 'sc_west_montee', label: 'Westminster montant', build: () => arpeggio({ freqs: [392, 523, 659, 784], step: 0.22, dur: 0.40, type: 'sine' }) },
      { id: 'sc_or_pur',      label: 'Or pur (cloche)', build: () => bellChime({ freqs: [880, 1318, 1760], dur: 1.0, ratios: [1, 0.45, 0.2] }) },
      { id: 'sc_velours_or',  label: 'Velours or', build: () => arpeggio({ freqs: [659, 988, 1318], step: 0.10, dur: 0.30, type: 'sine' }) },
      { id: 'sc_rideau_fin',  label: 'Rideau de fin', build: () => softWhoosh({ dur: 1.2, fromHz: 200, toHz: 1500 }) },
      { id: 'sc_carillon',    label: 'Carillon court', build: () => arpeggio({ freqs: [1046, 1318, 1568, 1976], step: 0.10, dur: 0.32, type: 'triangle' }) },
      { id: 'sc_doux_haut',   label: 'Doux haut', build: () => bellChime({ freqs: [1568, 2349], dur: 0.85, ratios: [1, 0.5] }) },
      { id: 'sc_acte_final',  label: 'Acte final', build: () => arpeggio({ freqs: [392, 587, 784, 1175], step: 0.14, dur: 0.30, type: 'triangle' }) },
      { id: 'sc_silence',     label: '— Silence —', build: () => () => {} },
    ],

    // ============== Page transition (entre écrans) ==============
    transition: [
      { id: 'tr_soie_courte',  label: 'Soie courte', build: () => softWhoosh({ dur: 0.35, fromHz: 200, toHz: 1400 }) },
      { id: 'tr_souffle',      label: 'Souffle', build: () => softWhoosh({ dur: 0.4, fromHz: 800, toHz: 200 }) },
      { id: 'tr_velours_pass', label: 'Velours qui passe', build: () => softWhoosh({ dur: 0.5, fromHz: 300, toHz: 900 }) },
      { id: 'tr_chime_court',  label: 'Chime court', build: () => bellChime({ freqs: [880], dur: 0.18, ratios: [1] }) },
      { id: 'tr_tap_sourd',    label: 'Tap sourd', build: () => softKnock({ freq: 280, dur: 0.10 }) },
      { id: 'tr_swoosh_haut',  label: 'Swoosh haut', build: () => softWhoosh({ dur: 0.30, fromHz: 1200, toHz: 3000, hp: true }) },
      { id: 'tr_pli_velours',  label: 'Pli velours', build: () => softWhoosh({ dur: 0.35, fromHz: 400, toHz: 800 }) },
      { id: 'tr_brief_tone',   label: 'Tone bref', build: () => pulseTone({ freq: 660, type: 'sine', dur: 0.10, a: 0.005, r: 0.08 }) },
      { id: 'tr_double_tap',   label: 'Double tap', build: () => arpeggio({ freqs: [880, 1100], step: 0.05, dur: 0.06, type: 'triangle' }) },
      { id: 'tr_silence',      label: '— Silence —', build: () => () => {} },
    ],
  };

  // SOUND_EVENTS : liste maître exposée à l'éditeur. order matters (ordre
  // d'affichage). Chaque event a un labelFR + un descriptionFR + un default.
  const SOUND_EVENTS = [
    { key: 'ui_tap', label: 'Tap UI (boutons secondaires)',
      desc: 'Tap discret sur les boutons et dots — le son qui ponctue chaque interaction.',
      defaultPreset: 'tap_velours' },
    { key: 'ui_cta', label: 'CTA primaire (boutons or)',
      desc: 'Quand on appuie sur un gros bouton or (Commencer, Niveau 1, Suivant, Parler, Valider).',
      defaultPreset: 'cta_chime_or' },
    { key: 'validate_good', label: 'Validation — bonne réponse',
      desc: 'Quand on choisit la bonne réponse au QCM ou le meilleur choix de dialogue.',
      defaultPreset: 'good_acte' },
    { key: 'validate_bad', label: 'Validation — choix faible',
      desc: 'Quand on choisit une mauvaise réponse au QCM ou un choix moins bon.',
      defaultPreset: 'bad_velours_grave' },
    { key: 'zoom_in', label: 'Zoom caméra',
      desc: 'Quand on clique sur un personnage et que la caméra zoome dessus. Famille « coup de vent / coup raté » : sons aériens, whooshes, sifflements de lame.',
      defaultPreset: 'zoom_coup_vent' },
    { key: 'score_reveal', label: 'Score / Verdict',
      desc: 'Quand l\'écran de score apparaît (% géant, Bravo!).',
      defaultPreset: 'sc_fanfare' },
    { key: 'transition', label: 'Transition d\'écran',
      desc: 'À chaque changement d\'écran (Brief, Map, Score).',
      defaultPreset: 'tr_soie_courte' },
  ];

  // Volume global (0..1). Modifié par le mute/unmute.
  let _master = 0.75;
  let _muted = false;

  function setMasterVolume(v) { _master = Math.max(0, Math.min(1, v)); }
  function setMuted(m) { _muted = !!m; }
  function isMuted() { return _muted; }

  // ---------- API : playSound(eventKey, presetIdOrMap) ----------
  // Si presetIdOrMap est un objet (le meta.sounds du module), on regarde
  // dedans pour cet eventKey. Sinon on l'utilise comme presetId direct.
  // Si rien n'est trouvé, on joue le defaultPreset de l'événement.
  function playSound(eventKey, presetIdOrMap) {
    if (_muted) return;
    let presetId = null;
    if (typeof presetIdOrMap === 'string') presetId = presetIdOrMap;
    else if (presetIdOrMap && typeof presetIdOrMap === 'object') presetId = presetIdOrMap[eventKey];
    const ev = SOUND_EVENTS.find(e => e.key === eventKey);
    if (!ev) return;
    if (!presetId) presetId = ev.defaultPreset;
    const list = PRESETS[eventKey] || [];
    const preset = list.find(p => p.id === presetId) || list[0];
    if (!preset) return;
    try {
      const player = preset.build();
      player(_master);
    } catch (e) { /* AudioContext indisponible ou bloqué */ }
  }

  // ---------- API : previewPreset(eventKey, presetId) ----------
  // Comme playSound, mais ignore le mute (l'éditeur l'utilise pour
  // auditionner les alternatives même si le son est désactivé au jeu).
  function previewPreset(eventKey, presetId) {
    const list = PRESETS[eventKey] || [];
    const preset = list.find(p => p.id === presetId);
    if (!preset) return;
    try {
      const player = preset.build();
      player(Math.max(_master, 0.5));
    } catch (e) {}
  }

  // ---------- Reverse playback ----------
  // Rend un preset hors-ligne dans un OfflineAudioContext (en redirigeant
  // ctx() via _audioCtxOverride), puis renvoie le buffer rendu.
  async function _renderPresetToBuffer(preset, maxDur = 2.5) {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) return null;
    const sr = 44100;
    const length = Math.ceil(sr * maxDur);
    let oac;
    try { oac = new Offline(1, length, sr); } catch { return null; }
    // Bascule ctx() vers oac le temps de build+schedule, puis remet.
    _audioCtxOverride = oac;
    try {
      const player = preset.build();
      player(0.7);
    } catch (e) {
      _audioCtxOverride = null;
      return null;
    }
    _audioCtxOverride = null;
    return await oac.startRendering();
  }

  // Joue un preset À L'ENVERS. Pipeline :
  //   1. Render hors-ligne le preset → AudioBuffer
  //   2. Trim trailing silence (devient leading silence après reverse)
  //   3. Reverse les samples
  //   4. Play via BufferSource sur le contexte temps réel
  async function playReversed(eventKey, presetIdOrMap) {
    if (_muted) return;
    let presetId = null;
    if (typeof presetIdOrMap === 'string') presetId = presetIdOrMap;
    else if (presetIdOrMap && typeof presetIdOrMap === 'object') presetId = presetIdOrMap[eventKey];
    const ev = SOUND_EVENTS.find(e => e.key === eventKey);
    if (!ev) return;
    if (!presetId) presetId = ev.defaultPreset;
    const list = PRESETS[eventKey] || [];
    const preset = list.find(p => p.id === presetId) || list[0];
    if (!preset) return;
    const buffer = await _renderPresetToBuffer(preset, 2.5);
    if (!buffer) return;
    const data = buffer.getChannelData(0);
    // Trim trailing silence (seuil bas pour ne pas couper un fade discret).
    let lastNonZero = data.length - 1;
    while (lastNonZero > 0 && Math.abs(data[lastNonZero]) < 0.0008) lastNonZero--;
    const trimmedLen = lastNonZero + 1;
    if (trimmedLen < 200) return;
    const realCtx = ctx();
    if (!realCtx) return;
    const out = realCtx.createBuffer(1, trimmedLen, buffer.sampleRate);
    const dst = out.getChannelData(0);
    for (let i = 0; i < trimmedLen; i++) dst[i] = data[trimmedLen - 1 - i];
    const src = realCtx.createBufferSource();
    src.buffer = out;
    const g = realCtx.createGain();
    g.gain.value = _master;
    src.connect(g); g.connect(realCtx.destination);
    src.start();
  }

  global.AccrocheSFX = {
    PRESETS, SOUND_EVENTS,
    playSound, previewPreset, playReversed,
    setMasterVolume, setMuted, isMuted,
  };

})(window);
