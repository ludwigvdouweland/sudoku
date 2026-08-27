// sounds.js — lightweight sound effects for the game, synthesized with the
// Web Audio API. No audio assets to ship or license — every effect is a
// short tone/tone-sequence generated on the fly.

const MUTE_KEY = 'sudoku:muted';

let ctx = null;
let masterGain = null;

function ensureContext() {
  if (ctx) return ctx;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  ctx = new AudioContextClass();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.35;
  masterGain.connect(ctx.destination);
  return ctx;
}

/** Browsers start AudioContexts suspended until a user gesture; call this from the first pointer/key handler. */
function resume() {
  const c = ensureContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

let muted = localStorage.getItem(MUTE_KEY) === '1';

function isMuted() {
  return muted;
}

function setMuted(value) {
  muted = !!value;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
}

function toggleMuted() {
  setMuted(!muted);
  return muted;
}

/**
 * Plays a single tone with a short attack and exponential decay.
 * @param {number} freq starting frequency in Hz
 */
function playTone(freq, { duration = 0.15, type = 'sine', gain = 0.25, delay = 0, freqEnd = null } = {}) {
  if (muted) return;
  const c = ensureContext();
  if (!c) return;
  const t0 = c.currentTime + delay;

  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + duration);
  }

  const g = c.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

  osc.connect(g);
  g.connect(masterGain);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function playSequence(notes) {
  notes.forEach((n) => playTone(n.freq, n));
}

// ---------------------------------------------------------------------------
// Named effects
// ---------------------------------------------------------------------------

export const sfx = {
  init: resume,
  isMuted,
  setMuted,
  toggleMuted,

  /** Generic UI tap — menu buttons, toggles, etc. */
  click() {
    playTone(700, { duration: 0.055, type: 'square', gain: 0.07 });
  },

  /** A valid number placed in a cell. */
  place() {
    playTone(660, { duration: 0.1, type: 'sine', gain: 0.22 });
  },

  /** A cell cleared back to blank. */
  erase() {
    playTone(320, { duration: 0.09, type: 'sine', gain: 0.15, freqEnd: 200 });
  },

  /** A pencil-mark candidate toggled. */
  note() {
    playTone(900, { duration: 0.05, type: 'triangle', gain: 0.1 });
  },

  /** A wrong number entered. */
  error() {
    playSequence([
      { freq: 180, duration: 0.16, type: 'sawtooth', gain: 0.2 },
      { freq: 140, duration: 0.18, type: 'sawtooth', gain: 0.2, delay: 0.09 },
    ]);
  },

  /** A hint filled a cell in. */
  hint() {
    playSequence([
      { freq: 523.25, duration: 0.12, type: 'sine', gain: 0.18 },
      { freq: 783.99, duration: 0.18, type: 'sine', gain: 0.18, delay: 0.1 },
    ]);
  },

  /** A fresh puzzle is ready. */
  newGame() {
    playSequence([
      { freq: 440, duration: 0.1, type: 'sine', gain: 0.15 },
      { freq: 587.33, duration: 0.16, type: 'sine', gain: 0.15, delay: 0.09 },
    ]);
  },

  /** The board was auto-solved. */
  solve() {
    playSequence([
      { freq: 392, duration: 0.1, type: 'triangle', gain: 0.16 },
      { freq: 523.25, duration: 0.12, type: 'triangle', gain: 0.16, delay: 0.08 },
      { freq: 659.25, duration: 0.16, type: 'triangle', gain: 0.16, delay: 0.16 },
    ]);
  },

  /** Puzzle solved by the player — a little victory fanfare. */
  win() {
    playSequence([
      { freq: 523.25, duration: 0.14, type: 'sine', gain: 0.2 },
      { freq: 659.25, duration: 0.14, type: 'sine', gain: 0.2, delay: 0.12 },
      { freq: 783.99, duration: 0.14, type: 'sine', gain: 0.2, delay: 0.24 },
      { freq: 1046.5, duration: 0.28, type: 'sine', gain: 0.22, delay: 0.36 },
    ]);
  },
};
