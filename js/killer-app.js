// killer-app.js — UI for the Killer Sudoku page (killer.html). Plays the one
// puzzle from killer-puzzle.js; there's no generator, solver or solution in
// here on purpose — the page offers decision support (rule-based candidates,
// cage combinations, conflicts, rule-of-45 hints) and leaves the solving to
// the player. Entry point loaded as a module from killer.html.

import { PUZZLE } from './killer-puzzle.js';
import {
  SIZE, bit, maskToDigits, buildModel, computeCandidates, deduceCandidates, findConflicts,
  analyzeCage, hiddenSingles, ruleOf45, missingDigits, isComplete,
} from './killer-logic.js';
import { sfx } from './sounds.js';

const model = buildModel(PUZZLE);
const STORAGE_KEY = `killer:progress:v1:${PUZZLE.id}`;
const CANDIDATE_MODES = ['off', 'selected', 'all', 'fewest'];
const DEDUCE_PASSES = { step: 1, full: Infinity };
const MAX_UNDO = 300;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

const state = {
  board: emptyBoard(), // entered digits, 0 = empty (the puzzle has no givens)
  notes: emptyBoard(), // pencil marks per cell, as digit masks
  selected: null, // [r, c]
  notesMode: false,
  candidateMode: 'off', // 'off' | 'selected' | 'all' | 'fewest'
  deduce: 'step', // deduction depth for candidates: 'off' | 'step' | 'full'
  undo: [], // snapshots of { board, notes } before each change
  solved: false,
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const boardEl = document.getElementById('board');
const linesEl = document.getElementById('boardLines');
const filledTag = document.getElementById('filledTag');
const conflictTag = document.getElementById('conflictTag');
const winOverlay = document.getElementById('winOverlay');
const closeWinBtn = document.getElementById('closeWinBtn');
const winResetBtn = document.getElementById('winResetBtn');
const numpad = document.getElementById('numpad');
const notesBtn = document.getElementById('notesBtn');
const undoBtn = document.getElementById('undoBtn');
const resetBtn = document.getElementById('resetBtn');
const analysisBody = document.getElementById('analysisBody');
const themeToggle = document.getElementById('themeToggle');
const soundToggle = document.getElementById('soundToggle');
const candButtons = Array.from(document.querySelectorAll('.cand-btn[data-mode]'));
const deduceButtons = Array.from(document.querySelectorAll('.deduce-btn'));

const cellEls = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
const cageGroups = []; // SVG <g> per cage, for highlight/error styling

// ---------------------------------------------------------------------------
// Persistence (per-browser convenience only; the page works without it)
// ---------------------------------------------------------------------------

function saveProgress() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      board: state.board,
      notes: state.notes,
      candidateMode: state.candidateMode,
      deduce: state.deduce,
    }));
  } catch (err) {
    console.warn('Killer Sudoku: failed to save progress', err);
  }
}

function loadProgress() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!saved) return;
    const valid = (g) => Array.isArray(g) && g.length === SIZE && g.every((row) => Array.isArray(row) && row.length === SIZE);
    if (valid(saved.board)) state.board = saved.board.map((row) => row.map((v) => (v >= 1 && v <= 9 ? v : 0)));
    if (valid(saved.notes)) state.notes = saved.notes.map((row) => row.map((m) => (Number(m) || 0) & 0x1ff));
    if (CANDIDATE_MODES.includes(saved.candidateMode)) state.candidateMode = saved.candidateMode;
    if (saved.deduce === 'off' || DEDUCE_PASSES[saved.deduce]) state.deduce = saved.deduce;
  } catch (err) {
    console.warn('Killer Sudoku: failed to load progress', err);
  }
}

// ---------------------------------------------------------------------------
// Board construction: HTML cells for interaction/digits, one SVG overlay for
// all the line work (grid, diagonals, cages, regions).
// ---------------------------------------------------------------------------

function buildBoardDom() {
  boardEl.innerHTML = '';
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.row = String(r);
      cell.dataset.col = String(c);
      cell.setAttribute('role', 'gridcell');
      boardEl.appendChild(cell);
      cellEls[r][c] = cell;
    }
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const U = 100; // SVG units per cell (viewBox is 900x900)
const INSET = 9; // cage outline inset from the cell edge

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function line(x1, y1, x2, y2, cls) {
  return svgEl('line', { x1, y1, x2, y2, class: cls });
}

/**
 * Dashed inset outline of one cage, drawn edge by edge. Each boundary edge
 * runs parallel to the cell side, INSET inside it; at each end it stops short
 * at a convex corner, runs to the cell edge where the outline continues
 * straight into the neighbouring cage cell, and overshoots at a concave
 * corner so it meets the neighbour's perpendicular edge.
 */
function cageOutline(index) {
  const inCage = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE && model.cageOf[r][c] === index;
  // Start (low-coordinate) and finish (high-coordinate) ends of an edge.
  // `perp`: the perpendicular neighbour at that end is in the cage;
  // `diag`: so is the diagonal cell beyond that corner (concave corner).
  const start = (side, perp, diag) => (!perp ? side + INSET : diag ? side - INSET : side);
  const finish = (side, perp, diag) => (!perp ? side - INSET : diag ? side + INSET : side);
  const g = svgEl('g', { class: 'cage' });
  const [hr, hc] = model.cages[index].head;

  for (const [r, c] of model.cages[index].cells) {
    const x0 = c * U;
    const y0 = r * U;
    const x1 = x0 + U;
    const y1 = y0 + U;
    const isHead = r === hr && c === hc;
    // The sum label sits in the head cell's top-left corner; leave it room.
    // (The head is first in reading order, so its top and left are always outline edges.)
    const labelW = isHead ? 40 : 0;
    const labelH = isHead ? 32 : 0;

    if (!inCage(r - 1, c)) {
      const y = y0 + INSET;
      g.appendChild(line(
        Math.max(start(x0, inCage(r, c - 1), inCage(r - 1, c - 1)), x0 + labelW), y,
        finish(x1, inCage(r, c + 1), inCage(r - 1, c + 1)), y, 'cage-line'));
    }
    if (!inCage(r + 1, c)) {
      const y = y1 - INSET;
      g.appendChild(line(
        start(x0, inCage(r, c - 1), inCage(r + 1, c - 1)), y,
        finish(x1, inCage(r, c + 1), inCage(r + 1, c + 1)), y, 'cage-line'));
    }
    if (!inCage(r, c - 1)) {
      const x = x0 + INSET;
      g.appendChild(line(
        x, Math.max(start(y0, inCage(r - 1, c), inCage(r - 1, c - 1)), y0 + labelH),
        x, finish(y1, inCage(r + 1, c), inCage(r + 1, c - 1)), 'cage-line'));
    }
    if (!inCage(r, c + 1)) {
      const x = x1 - INSET;
      g.appendChild(line(
        x, start(y0, inCage(r - 1, c), inCage(r - 1, c + 1)),
        x, finish(y1, inCage(r + 1, c), inCage(r + 1, c + 1)), 'cage-line'));
    }
  }
  return g;
}

function buildLinesSvg() {
  linesEl.innerHTML = '';

  for (let i = 1; i < SIZE; i++) {
    linesEl.appendChild(line(i * U, 0, i * U, SIZE * U, 'grid-line'));
    linesEl.appendChild(line(0, i * U, SIZE * U, i * U, 'grid-line'));
  }

  if (PUZZLE.diagonals) {
    linesEl.appendChild(line(0, 0, SIZE * U, SIZE * U, 'diag-line'));
    linesEl.appendChild(line(SIZE * U, 0, 0, SIZE * U, 'diag-line'));
  }

  model.cages.forEach((_, i) => {
    const g = cageOutline(i);
    cageGroups[i] = g;
    linesEl.appendChild(g);
  });

  // Region boundaries: a thick segment wherever neighbouring cells differ.
  const reg = model.regionOf;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (c < SIZE - 1 && reg[r][c] !== reg[r][c + 1]) {
        linesEl.appendChild(line((c + 1) * U, r * U, (c + 1) * U, (r + 1) * U, 'region-line'));
      }
      if (r < SIZE - 1 && reg[r][c] !== reg[r + 1][c]) {
        linesEl.appendChild(line(c * U, (r + 1) * U, (c + 1) * U, (r + 1) * U, 'region-line'));
      }
    }
  }

  linesEl.appendChild(svgEl('rect', { x: 0, y: 0, width: SIZE * U, height: SIZE * U, class: 'outer-line' }));
}

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  selectCell(Number(cell.dataset.row), Number(cell.dataset.col));
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

const cloneGrid = (g) => g.map((row) => row.slice());

function pushUndo() {
  state.undo.push({ board: cloneGrid(state.board), notes: cloneGrid(state.notes) });
  if (state.undo.length > MAX_UNDO) state.undo.shift();
}

function undo() {
  const snap = state.undo.pop();
  if (!snap) return;
  state.board = snap.board;
  state.notes = snap.notes;
  state.solved = false;
  hideWin();
  sfx.erase();
  render();
  saveProgress();
}

function resetBoard() {
  if (!window.confirm('Clear the whole board, including your notes?')) return;
  pushUndo();
  state.board = emptyBoard();
  state.notes = emptyBoard();
  state.solved = false;
  state.selected = null;
  hideWin();
  sfx.newGame();
  render();
  saveProgress();
}

function selectCell(r, c) {
  state.selected = [r, c];
  render();
}

function moveSelection(dr, dc) {
  if (!state.selected) return selectCell(0, 0);
  const [r, c] = state.selected;
  selectCell(Math.min(SIZE - 1, Math.max(0, r + dr)), Math.min(SIZE - 1, Math.max(0, c + dc)));
}

// Cells sharing a row/column/region/diagonal or the cage with (r, c).
function peersOf(r, c) {
  const keys = new Set();
  for (const u of model.unitsOf[r][c]) model.units[u].cells.forEach(([rr, cc]) => keys.add(`${rr},${cc}`));
  model.cages[model.cageOf[r][c]].cells.forEach(([rr, cc]) => keys.add(`${rr},${cc}`));
  keys.delete(`${r},${c}`);
  return keys;
}

function setCellValue(r, c, value) {
  if (state.solved) return;

  if (state.notesMode && value !== 0) {
    if (state.board[r][c]) return; // no pencil marks over a filled cell
    pushUndo();
    state.notes[r][c] ^= bit(value);
    sfx.note();
    render();
    saveProgress();
    return;
  }

  if (state.board[r][c] === value && (value !== 0 || !state.notes[r][c])) return;
  pushUndo();
  state.board[r][c] = value;
  state.notes[r][c] = 0;

  if (value) {
    // Placing a digit rules it out for every peer's pencil marks (Undo brings them back).
    for (const key of peersOf(r, c)) {
      const [rr, cc] = key.split(',').map(Number);
      state.notes[rr][cc] &= ~bit(value);
    }
    const { cells, cages } = findConflicts(model, state.board);
    if (cells.has(`${r},${c}`) || cages.has(model.cageOf[r][c])) sfx.error();
    else sfx.place();
  } else {
    sfx.erase();
  }

  render();
  saveProgress();

  if (isComplete(model, state.board)) {
    state.solved = true;
    sfx.win();
    winOverlay.classList.remove('hidden');
  }
}

function hideWin() {
  winOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildNotesGrid(mask, extraClass) {
  const grid = document.createElement('div');
  grid.className = extraClass ? `notes-grid ${extraClass}` : 'notes-grid';
  for (let d = 1; d <= 9; d++) {
    const span = document.createElement('span');
    span.textContent = mask & bit(d) ? String(d) : '';
    grid.appendChild(span);
  }
  return grid;
}

function findFewestCandidateCells(cand) {
  let count = Infinity;
  let cells = new Set();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[r][c]) continue;
      const n = maskToDigits(cand[r][c]).length;
      if (n < count) {
        count = n;
        cells = new Set([`${r},${c}`]);
      } else if (n === count) {
        cells.add(`${r},${c}`);
      }
    }
  }
  return count === Infinity ? { count: null, cells: null } : { count, cells };
}

function render() {
  const { board, notes, selected } = state;
  const { cand, reasons } = state.deduce !== 'off'
    ? deduceCandidates(model, board, { passes: DEDUCE_PASSES[state.deduce] })
    : { cand: computeCandidates(model, board), reasons: null };
  const conflicts = findConflicts(model, board);
  const peers = selected ? peersOf(selected[0], selected[1]) : new Set();
  const selectedValue = selected ? board[selected[0]][selected[1]] : 0;
  const selectedCage = selected ? model.cageOf[selected[0]][selected[1]] : -1;
  const fewest = state.candidateMode === 'fewest' ? findFewestCandidateCells(cand) : { count: null, cells: null };

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = cellEls[r][c];
      const key = `${r},${c}`;
      const value = board[r][c];
      const cageIndex = model.cageOf[r][c];
      const isSelected = !!selected && selected[0] === r && selected[1] === c;

      cell.classList.toggle('selected', isSelected);
      cell.classList.toggle('peer', peers.has(key));
      cell.classList.toggle('same-value', !!selectedValue && value === selectedValue && !isSelected);
      cell.classList.toggle('error', conflicts.cells.has(key) || (!!value && conflicts.cages.has(cageIndex)));

      const isFewest = !!fewest.cells && fewest.cells.has(key);
      cell.classList.toggle('fewest-hint', isFewest);
      cell.classList.toggle('contradiction', isFewest && fewest.count === 0);

      const children = [];
      const cage = model.cages[cageIndex];
      if (cage.head[0] === r && cage.head[1] === c) {
        const label = document.createElement('span');
        label.className = 'cage-sum';
        label.textContent = String(cage.sum);
        children.push(label);
      }

      if (value) {
        const digit = document.createElement('span');
        digit.className = 'cell-value';
        digit.textContent = String(value);
        children.push(digit);
      } else {
        const showAuto = state.candidateMode === 'all' || (state.candidateMode === 'selected' && isSelected);
        if (showAuto) children.push(buildNotesGrid(cand[r][c], 'auto'));
        else if (notes[r][c]) children.push(buildNotesGrid(notes[r][c]));
      }

      if (isFewest) {
        const badge = document.createElement('span');
        badge.className = fewest.count === 0 ? 'candidate-badge contradiction' : 'candidate-badge';
        badge.textContent = String(fewest.count);
        children.push(badge);
      }
      cell.replaceChildren(...children);
    }
  }

  cageGroups.forEach((g, i) => {
    g.classList.toggle('active', i === selectedCage);
    g.classList.toggle('bad', conflicts.cages.has(i));
  });

  const filled = board.flat().filter(Boolean).length;
  filledTag.textContent = `Filled: ${filled} / 81`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const problems = [
    conflicts.cells.size ? plural(conflicts.cells.size, 'clashing cell') : '',
    conflicts.cages.size ? plural(conflicts.cages.size, 'bad cage') : '',
  ].filter(Boolean);
  conflictTag.textContent = problems.length ? `⚠ ${problems.join(', ')}` : 'No conflicts';
  conflictTag.classList.toggle('bad', problems.length > 0);
  undoBtn.disabled = state.undo.length === 0;
  notesBtn.setAttribute('aria-pressed', String(state.notesMode));

  renderAnalysis(cand, reasons, conflicts);
}

// ---------------------------------------------------------------------------
// Decision support panel
// ---------------------------------------------------------------------------

const cellName = ([r, c]) => `r${r + 1}c${c + 1}`;

function chips(digits, cls = '') {
  if (!digits.length) return '<span class="muted">none</span>';
  return digits.map((d) => `<span class="chip ${cls}">${d}</span>`).join('');
}

function renderAnalysis(cand, reasons, conflicts) {
  if (!state.selected) {
    analysisBody.innerHTML = `
      <p class="muted">Select a cell to see its candidates, its cage's possible digit
      combinations, and what's still missing from its row, column, region and diagonals.</p>
      <p class="muted">Candidates follow from the rules and the digits on the board. With
      <em>Eliminations</em> on, they also apply the deductions you'd make with pencil
      marks — digits a cage is sure to contain, naked pairs/triples, locked candidates — and
      each cell lists why digits were ruled out. There's no solver or stored answer behind
      them, so a wrong digit you enter is only flagged once it breaks a rule.</p>`;
    return;
  }

  const [r, c] = state.selected;
  const value = state.board[r][c];
  const cageIndex = model.cageOf[r][c];
  const info = analyzeCage(model, state.board, cand, cageIndex);
  const cage = model.cages[cageIndex];
  const sections = [];

  // --- Cell ---
  if (value) {
    sections.push(`<section><h3>Cell ${cellName([r, c])}</h3><p>Filled with <strong>${value}</strong>.</p></section>`);
  } else {
    const digits = maskToDigits(cand[r][c]);
    const singles = hiddenSingles(model, state.board, cand, r, c);
    const notes = [];
    if (digits.length === 0) notes.push('<p class="bad">No digit fits here — an earlier entry must be wrong.</p>');
    else if (digits.length === 1) notes.push(`<p class="good">Only ${digits[0]} fits here (naked single).</p>`);
    for (const { unitIndex, digit } of singles) {
      notes.push(`<p class="good">${digit} can only go here in ${model.units[unitIndex].label.toLowerCase()} (hidden single).</p>`);
    }
    const why = reasons ? reasons[r][c] : [];
    if (why.length) {
      notes.push(`<div class="eliminations"><div class="muted">Ruled out by deduction:</div><ul>${
        why.map(({ mask, text }) => `<li><strong>${maskToDigits(mask).join(', ')}</strong> — ${text}</li>`).join('')
      }</ul></div>`);
    }
    sections.push(`
      <section>
        <h3>Cell ${cellName([r, c])}</h3>
        <div class="chip-row">${chips(digits, 'cand')}</div>
        ${notes.join('')}
      </section>`);
  }

  // --- Cage ---
  const possible = new Set(info.combos);
  const comboRows = info.allCombos.map((mask) => {
    const ok = possible.has(mask);
    return `<span class="combo ${ok ? '' : 'ruled-out'}" title="${ok ? 'Still possible' : 'Ruled out by the board'}">${maskToDigits(mask).join('')}</span>`;
  }).join('');
  let cageStatus = `${info.remaining} left over ${info.emptyCount} empty cell${info.emptyCount === 1 ? '' : 's'}`;
  if (conflicts.cages.has(cageIndex)) cageStatus = '<span class="bad">Placed digits don’t fit the sum</span>';
  else if (info.emptyCount === 0) cageStatus = '<span class="good">Complete</span>';
  else if (!info.combos.length) cageStatus += ' · <span class="bad">no combination fits any more</span>';

  sections.push(`
    <section>
      <h3>Cage ${info.sum} <span class="muted">· ${info.size} cells (${cage.cells.map(cellName).join(', ')})</span></h3>
      <p>${cageStatus}</p>
      <div class="combo-row">${comboRows || '<span class="muted">No digit set can make this sum.</span>'}</div>
      ${info.emptyCount && info.mustContain ? `<p>Must still contain: ${chips(maskToDigits(info.mustContain), 'must')}</p>` : ''}
    </section>`);

  // --- Units ---
  const unitRows = model.unitsOf[r][c].map((u) => {
    const unit = model.units[u];
    const missing = maskToDigits(missingDigits(model, state.board, u));
    const rule = ruleOf45(model, u);
    let rule45 = '';
    if (rule.cells.length && rule.cells.length <= 4) {
      rule45 = `<div class="rule45" title="Rule of 45: the unit sums to 45; the cages fully inside it cover the rest">45 rule: ${rule.cells.map(cellName).join(' + ')} = <strong>${rule.sum}</strong></div>`;
    }
    return `
      <div class="unit-row">
        <div class="unit-name">${unit.label}</div>
        <div class="chip-row">${missing.length ? chips(missing) : '<span class="good">complete</span>'}</div>
        ${rule45}
      </div>`;
  }).join('');
  sections.push(`<section><h3>Still missing</h3>${unitRows}</section>`);

  analysisBody.innerHTML = sections.join('');
}

// ---------------------------------------------------------------------------
// Candidate display, theme, sound
// ---------------------------------------------------------------------------

function setCandidateMode(mode) {
  state.candidateMode = mode;
  candButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  render();
  saveProgress();
}

function cycleCandidateMode() {
  const i = CANDIDATE_MODES.indexOf(state.candidateMode);
  setCandidateMode(CANDIDATE_MODES[(i + 1) % CANDIDATE_MODES.length]);
}

// Same theme key as the classic page, so both pages stay in sync.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function initTheme() {
  try {
    const saved = localStorage.getItem('sudoku:theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
  } catch { /* storage unavailable — fall back to the system theme */ }
  themeToggle.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
}
function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('sudoku:theme', next); } catch { /* ignore */ }
  themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
}

function updateSoundIcon() {
  soundToggle.textContent = sfx.isMuted() ? '🔇' : '🔊';
}

window.addEventListener('pointerdown', sfx.init, { once: true });
window.addEventListener('keydown', sfx.init, { once: true });

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function setDeduce(level) {
  state.deduce = level;
  deduceButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.deduce === level));
  render();
  saveProgress();
}

deduceButtons.forEach((btn) => btn.addEventListener('click', () => {
  sfx.click();
  setDeduce(btn.dataset.deduce);
}));

candButtons.forEach((btn) => btn.addEventListener('click', () => {
  sfx.click();
  setCandidateMode(btn.dataset.mode);
}));

numpad.addEventListener('click', (e) => {
  const btn = e.target.closest('.num-btn');
  if (!btn || !state.selected) return;
  setCellValue(state.selected[0], state.selected[1], Number(btn.dataset.num));
});

notesBtn.addEventListener('click', () => {
  sfx.click();
  state.notesMode = !state.notesMode;
  render();
});
undoBtn.addEventListener('click', undo);
resetBtn.addEventListener('click', () => {
  sfx.click();
  resetBoard();
});
closeWinBtn.addEventListener('click', () => {
  sfx.click();
  hideWin();
});
winResetBtn.addEventListener('click', () => {
  sfx.click();
  resetBoard();
});
themeToggle.addEventListener('click', () => {
  sfx.click();
  toggleTheme();
});
soundToggle.addEventListener('click', () => {
  sfx.toggleMuted();
  updateSoundIcon();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (!winOverlay.classList.contains('hidden')) hideWin();
    else {
      state.selected = null;
      render();
    }
    return;
  }
  if (e.key >= '1' && e.key <= '9') {
    if (state.selected) setCellValue(state.selected[0], state.selected[1], Number(e.key));
    return;
  }
  if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
    if (state.selected) setCellValue(state.selected[0], state.selected[1], 0);
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'n') {
    state.notesMode = !state.notesMode;
    render();
  } else if (k === 'c') {
    cycleCandidateMode();
  } else if (e.key === 'ArrowUp') { moveSelection(-1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { moveSelection(1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { moveSelection(0, -1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { moveSelection(0, 1); e.preventDefault(); }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

initTheme();
updateSoundIcon();
loadProgress();
buildBoardDom();
buildLinesSvg();
candButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === state.candidateMode));
deduceButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.deduce === state.deduce));
render();
state.solved = isComplete(model, state.board);
