// app.js — UI wiring. Entry point loaded as a module from index.html.

import { SIZE, cloneGrid, solveGrid, generatePuzzle, findConflicts, gridsEqual, computeCandidates } from './sudoku-engine.js';
import { solveGridMILPBinary, solveGridMILPInteger } from './milp-solver.js';
import { solveGridCP } from './cp-solver.js';
import { solveGridDLX } from './dlx-solver.js';
import { fetchPuzzleFromWeb } from './api.js';
import * as store from './storage.js';
import { estimatePerformance } from './estimate.js';
import { sfx } from './sounds.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  gameId: null,
  attemptId: null,
  puzzle: null, // givens grid, 0 = blank
  solution: null,
  board: null, // current entered values
  notes: null, // 9x9 of Set<number>
  selected: null, // [r, c]
  difficulty: 'normal',
  notesMode: false,
  source: 'local',
  elapsedMs: 0,
  mistakes: 0,
  solved: false,
  autoSolved: false,
  timerHandle: null,
  candidateMode: 'off', // 'off' | 'selected' | 'all' | 'fewest'
};

const CANDIDATE_MODES = ['off', 'selected', 'all', 'fewest'];

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const boardEl = document.getElementById('board');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const winOverlay = document.getElementById('winOverlay');
const winStats = document.getElementById('winStats');
const winFootnote = document.getElementById('winFootnote');
const sourceTag = document.getElementById('sourceTag');
const timerTag = document.getElementById('timer');
const mistakesTag = document.getElementById('mistakes');
const newGameBtn = document.getElementById('newGameBtn');
const onlineToggle = document.getElementById('onlineToggle');
const notesBtn = document.getElementById('notesBtn');
const hintBtn = document.getElementById('hintBtn');
const solveBtn = document.getElementById('solveBtn');
const resetBtn = document.getElementById('resetBtn');
const retryBtn = document.getElementById('retryBtn');
const playAgainBtn = document.getElementById('playAgainBtn');
const numpad = document.getElementById('numpad');
const themeToggle = document.getElementById('themeToggle');
const soundToggle = document.getElementById('soundToggle');
const historyBtn = document.getElementById('historyBtn');
const closeHistoryBtn = document.getElementById('closeHistoryBtn');
const historyPanel = document.getElementById('historyPanel');
const historyBackdrop = document.getElementById('historyBackdrop');
const historyList = document.getElementById('historyList');
const overallStats = document.getElementById('overallStats');
const solverBtn = document.getElementById('solverBtn');
const closeSolverBtn = document.getElementById('closeSolverBtn');
const solverPanel = document.getElementById('solverPanel');
const solverBackdrop = document.getElementById('solverBackdrop');
const solverMeta = document.getElementById('solverMeta');
const solverList = document.getElementById('solverList');
const diffButtons = Array.from(document.querySelectorAll('.diff-btn'));
const candButtons = Array.from(document.querySelectorAll('.cand-btn'));

const cellEls = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));

// ---------------------------------------------------------------------------
// Board DOM construction (built once; updated in place afterwards)
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

boardEl.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  selectCell(Number(cell.dataset.row), Number(cell.dataset.col));
});

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function startTimer() {
  stopTimer();
  state.timerHandle = setInterval(() => {
    if (document.hidden || state.solved) return;
    state.elapsedMs += 1000;
    timerTag.textContent = formatDuration(state.elapsedMs);
    if (state.gameId && state.attemptId) {
      store.updateAttemptProgress(state.gameId, state.attemptId, { elapsedMs: state.elapsedMs });
    }
  }, 1000);
}

function stopTimer() {
  if (state.timerHandle) {
    clearInterval(state.timerHandle);
    state.timerHandle = null;
  }
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------

function notesToPlain(notes) {
  return notes.map((row) => row.map((set) => Array.from(set)));
}

function notesFromPlain(plain) {
  if (!plain) return emptyNotes();
  return plain.map((row) => row.map((arr) => new Set(arr)));
}

function emptyNotes() {
  return Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => new Set()));
}

function persistProgress() {
  if (!state.gameId || !state.attemptId) return;
  store.updateAttemptProgress(state.gameId, state.attemptId, {
    board: state.board,
    notes: notesToPlain(state.notes),
    mistakes: state.mistakes,
    elapsedMs: state.elapsedMs,
  });
}

function setActiveDifficultyButton(difficulty) {
  diffButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.difficulty === difficulty));
}

async function startNewGame(difficulty, { online }) {
  state.difficulty = difficulty;
  setActiveDifficultyButton(difficulty);
  hideWinOverlay();
  showLoading(online ? 'Trying online puzzle source…' : 'Generating puzzle…');

  let puzzle = null;
  let solution = null;
  let source = 'local';

  if (online) {
    try {
      const webPuzzle = await fetchPuzzleFromWeb(difficulty);
      const webSolution = solveGrid(webPuzzle);
      if (!webSolution) throw new Error('Fetched puzzle has no solution');
      puzzle = webPuzzle;
      solution = webSolution;
      source = 'web';
    } catch (err) {
      console.warn('Online puzzle source unavailable, generating locally instead:', err);
      showLoading('Web source unavailable — generating locally…');
    }
  }

  if (!puzzle) {
    // Let the loading overlay paint before the (synchronous, CPU-bound) generation runs.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const generated = generatePuzzle(difficulty);
    puzzle = generated.puzzle;
    solution = generated.solution;
    source = 'local';
  }

  const clues = puzzle.flat().filter((v) => v !== 0).length;
  runSolverComparison(puzzle, solution, { difficulty, clues }); // background, not awaited
  const game = store.createGameRecord({ puzzle, solution, difficulty, source, clues });
  const attempt = store.startAttempt(game.id);

  applyGame(game, attempt);
  hideLoading();
  sfx.newGame();
}

/** Loads a stored game + attempt into live state (used for New Game, resume, retry). */
function applyGame(game, attempt) {
  state.gameId = game.id;
  state.attemptId = attempt.id;
  state.puzzle = game.puzzle;
  state.solution = game.solution;
  state.difficulty = game.difficulty;
  state.source = game.source;
  state.board = attempt.board ? cloneGrid(attempt.board) : cloneGrid(game.puzzle);
  state.notes = notesFromPlain(attempt.notes);
  state.mistakes = attempt.mistakes || 0;
  state.elapsedMs = attempt.elapsedMs || 0;
  state.solved = !!attempt.completed;
  state.autoSolved = !!attempt.autoSolved;
  state.selected = null;
  state.notesMode = false;

  setActiveDifficultyButton(state.difficulty);
  sourceTag.textContent = state.source === 'web' ? '🌐 Web puzzle' : '💻 Local puzzle';
  timerTag.textContent = formatDuration(state.elapsedMs);
  mistakesTag.textContent = `Mistakes: ${state.mistakes}`;
  notesBtn.setAttribute('aria-pressed', 'false');

  render();
  if (!state.solved) startTimer();
  else stopTimer();
}

// ---------------------------------------------------------------------------
// Solver comparison
//
// Runs all 5 solvers (backtracking, the CP solver from cp-solver.js, the DLX
// solver from dlx-solver.js, and the two MILP formulations from
// milp-solver.js) against every newly generated/fetched puzzle and times +
// cross-checks them. Deliberately NOT triggered by retry/resume — those
// reload the *same* puzzle, so there'd be nothing new to compare. Ephemeral,
// module-level state (not persisted, not part of `state`/storage.js) — it
// exists purely to feed the Solver Comparison panel and is lost on refresh
// like any other in-memory UI state.
// ---------------------------------------------------------------------------

const SOLVERS = [
  { key: 'backtracking', label: 'Backtracking (MRV)' },
  { key: 'cp', label: 'Constraint Propagation (CP)' },
  { key: 'dlx', label: 'Dancing Links (Algorithm X)' },
  { key: 'milpBinary', label: 'MILP — binary assignment (HiGHS)' },
  { key: 'milpInteger', label: 'MILP — integer cells (HiGHS)' },
];

let solverRun = null; // { meta: {difficulty, clues}, results: { [key]: {status, ms, matches, errorMessage} } }

/** Runs all 5 solvers against `puzzle`, timing each and checking the result
 *  against `solution` (the puzzle's known-correct solution — from the
 *  generator, which verifies uniqueness itself, or from solveGrid on a
 *  fetched puzzle). Fire-and-forget: doesn't block the board. */
async function runSolverComparison(puzzle, solution, meta) {
  const run = {
    meta,
    results: {
      backtracking: { status: 'pending' },
      cp: { status: 'pending' },
      dlx: { status: 'pending' },
      milpBinary: { status: 'pending' },
      milpInteger: { status: 'pending' },
    },
  };
  solverRun = run;
  renderSolverPanel();

  // Guards against a race: if a *newer* puzzle's comparison has already
  // started (and replaced solverRun) by the time an older run's async
  // solver resolves, drop that stale result instead of corrupting the
  // newer run's row.
  const setResult = (key, patch) => {
    if (solverRun !== run) return;
    run.results[key] = { ...run.results[key], ...patch };
    renderSolverPanel();
  };

  // Backtracking (sudoku-engine.js solveGrid) is synchronous.
  {
    const t0 = performance.now();
    try {
      const result = solveGrid(cloneGrid(puzzle));
      setResult('backtracking', {
        status: result ? 'solved' : 'infeasible',
        ms: performance.now() - t0,
        matches: result ? gridsEqual(result, solution) : null,
      });
    } catch (err) {
      console.error('Backtracking solver comparison failed:', err);
      setResult('backtracking', { status: 'error', ms: performance.now() - t0, errorMessage: String(err?.message || err) });
    }
  }

  // Constraint Propagation (cp-solver.js) is also pure JS/synchronous, no
  // WASM to await, same as backtracking above.
  {
    const t0 = performance.now();
    try {
      const result = solveGridCP(cloneGrid(puzzle));
      setResult('cp', {
        status: result ? 'solved' : 'infeasible',
        ms: performance.now() - t0,
        matches: result ? gridsEqual(result, solution) : null,
      });
    } catch (err) {
      console.error('CP solver comparison failed:', err);
      setResult('cp', { status: 'error', ms: performance.now() - t0, errorMessage: String(err?.message || err) });
    }
  }

  // Dancing Links (dlx-solver.js) is also pure JS/synchronous.
  {
    const t0 = performance.now();
    try {
      const result = solveGridDLX(cloneGrid(puzzle));
      setResult('dlx', {
        status: result ? 'solved' : 'infeasible',
        ms: performance.now() - t0,
        matches: result ? gridsEqual(result, solution) : null,
      });
    } catch (err) {
      console.error('DLX solver comparison failed:', err);
      setResult('dlx', { status: 'error', ms: performance.now() - t0, errorMessage: String(err?.message || err) });
    }
  }

  // The two MILP solvers (HiGHS) run concurrently in the background --
  // neither blocks the board, each other, or the backtracking result above.
  const runMilp = async (key, solverFn) => {
    const t0 = performance.now();
    try {
      const result = await solverFn(cloneGrid(puzzle));
      setResult(key, {
        status: result ? 'solved' : 'infeasible',
        ms: performance.now() - t0,
        matches: result ? gridsEqual(result, solution) : null,
      });
    } catch (err) {
      console.error(`${key} solver comparison failed:`, err);
      setResult(key, { status: 'error', ms: performance.now() - t0, errorMessage: String(err?.message || err) });
    }
  };
  runMilp('milpBinary', solveGridMILPBinary);
  runMilp('milpInteger', solveGridMILPInteger);
}

function solverStatusLabel(status) {
  switch (status) {
    case 'pending': return 'Running…';
    case 'solved': return 'Solved';
    case 'infeasible': return 'Infeasible';
    case 'error': return 'Error';
    default: return '—';
  }
}
function solverStatusTone(status) {
  if (status === 'solved') return 'good';
  if (status === 'infeasible' || status === 'error') return 'bad';
  return 'pending';
}

function renderSolverPanel() {
  if (!solverRun) {
    solverMeta.innerHTML = '';
    solverList.innerHTML = '<p class="history-empty">No comparison yet — start a New Game.</p>';
    return;
  }

  const { meta, results } = solverRun;
  solverMeta.innerHTML = `
    <span class="tag">${meta.difficulty}</span>
    <span class="tag">${meta.clues} clues</span>
  `;

  solverList.innerHTML = '';
  for (const { key, label } of SOLVERS) {
    const r = results[key] || { status: 'pending' };
    const matchNote = r.matches === true ? ' · matches solution ✓'
      : r.matches === false ? ' · MISMATCH ✗' : '';
    const metaLine = [
      r.ms != null ? `${Math.round(r.ms)} ms` : '—',
      matchNote,
      r.errorMessage ? ` · ${r.errorMessage}` : '',
    ].join('');

    const row = document.createElement('div');
    row.className = 'solver-row';
    row.innerHTML = `
      <div class="solver-row-top">
        <strong>${label}</strong>
        <span class="solver-status ${solverStatusTone(r.status)}">${solverStatusLabel(r.status)}</span>
      </div>
      <div class="solver-meta${r.matches === false ? ' bad' : ''}">${metaLine}</div>
    `;
    solverList.appendChild(row);
  }
}

function openSolverPanel() {
  renderSolverPanel();
  solverPanel.classList.remove('hidden');
  solverBackdrop.classList.remove('hidden');
}
function closeSolverPanel() {
  solverPanel.classList.add('hidden');
  solverBackdrop.classList.add('hidden');
}

function retryCurrentPuzzle() {
  if (!state.gameId) return;
  const game = store.getGame(state.gameId);
  if (!game) return;
  hideWinOverlay();
  const attempt = store.startAttempt(game.id);
  applyGame(game, attempt);
}

function resetBoard() {
  if (!state.puzzle || state.solved) return;
  state.board = cloneGrid(state.puzzle);
  state.notes = emptyNotes();
  render();
  persistProgress();
}

// ---------------------------------------------------------------------------
// Cell interaction
// ---------------------------------------------------------------------------

function selectCell(r, c) {
  state.selected = [r, c];
  render();
}

function moveSelection(dr, dc) {
  if (!state.selected) {
    selectCell(0, 0);
    return;
  }
  const [r, c] = state.selected;
  const nr = Math.min(SIZE - 1, Math.max(0, r + dr));
  const nc = Math.min(SIZE - 1, Math.max(0, c + dc));
  selectCell(nr, nc);
}

function isGiven(r, c) {
  return state.puzzle[r][c] !== 0;
}

function clearNoteFromPeers(r, c, value) {
  for (let i = 0; i < SIZE; i++) {
    state.notes[r][i].delete(value);
    state.notes[i][c].delete(value);
  }
  const br = r - (r % 3);
  const bc = c - (c % 3);
  for (let rr = br; rr < br + 3; rr++) {
    for (let cc = bc; cc < bc + 3; cc++) {
      state.notes[rr][cc].delete(value);
    }
  }
}

function setCellValue(r, c, value) {
  if (state.solved || isGiven(r, c)) return;

  if (state.notesMode) {
    if (value === 0 || state.board[r][c] !== 0) return; // no pencil marks over a filled cell
    const set = state.notes[r][c];
    if (set.has(value)) set.delete(value);
    else set.add(value);
    sfx.note();
    render();
    persistProgress();
    return;
  }

  state.board[r][c] = value;
  state.notes[r][c].clear();

  if (value !== 0) {
    if (value !== state.solution[r][c]) {
      state.mistakes += 1;
      mistakesTag.textContent = `Mistakes: ${state.mistakes}`;
      sfx.error();
    } else {
      clearNoteFromPeers(r, c, value);
      sfx.place();
    }
  } else {
    sfx.erase();
  }

  render();
  persistProgress();
  checkCompletion();
}

function applyHint() {
  if (!state.selected || state.solved) return;
  const [r, c] = state.selected;
  if (isGiven(r, c)) return;
  state.board[r][c] = state.solution[r][c];
  state.notes[r][c].clear();
  clearNoteFromPeers(r, c, state.solution[r][c]);
  sfx.hint();
  render();
  persistProgress();
  checkCompletion();
}

function solvePuzzle() {
  if (!state.solution) return;
  state.board = cloneGrid(state.solution);
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) state.notes[r][c].clear();
  state.autoSolved = true;
  sfx.solve();
  render();
  checkCompletion();
}

function checkCompletion() {
  if (state.board.flat().includes(0)) return;
  if (!gridsEqual(state.board, state.solution)) return;

  state.solved = true;
  stopTimer();
  if (!state.autoSolved) sfx.win();

  // Auto-solved runs are excluded from stats up front so they can never be read
  // back as a "best before" baseline either.
  const bestBefore = state.autoSolved ? null : store.getBestAttempt(state.gameId, state.attemptId);
  const avgBefore = state.autoSolved ? null : store.getDifficultyAverage(state.difficulty, state.attemptId);

  store.completeAttempt(state.gameId, state.attemptId, {
    elapsedMs: state.elapsedMs,
    mistakes: state.mistakes,
    autoSolved: state.autoSolved,
  });

  showWinOverlay({ bestBefore, avgBefore });
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildNotesGrid(numbers, extraClass) {
  const grid = document.createElement('div');
  grid.className = extraClass ? `notes-grid ${extraClass}` : 'notes-grid';
  for (let n = 1; n <= 9; n++) {
    const span = document.createElement('span');
    span.textContent = numbers.has ? (numbers.has(n) ? String(n) : '') : (numbers.includes(n) ? String(n) : '');
    grid.appendChild(span);
  }
  return grid;
}

/** Finds the empty cell(s) with the fewest remaining candidates (a "where to go next" hint). */
function findFewestCandidateCells(candidates) {
  let count = Infinity;
  let cells = new Set();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[r][c] !== 0) continue;
      const n = candidates[r][c].length;
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
  const conflicts = findConflicts(state.board);
  const selected = state.selected;
  const selectedValue = selected ? state.board[selected[0]][selected[1]] : 0;

  const candidates = state.candidateMode !== 'off' ? computeCandidates(state.board) : null;
  const fewest = state.candidateMode === 'fewest' && candidates
    ? findFewestCandidateCells(candidates)
    : { count: null, cells: null };

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = cellEls[r][c];
      const given = isGiven(r, c);
      const value = state.board[r][c];
      const key = `${r},${c}`;

      cell.classList.toggle('given', given);
      cell.classList.toggle('selected', !!selected && selected[0] === r && selected[1] === c);
      cell.classList.toggle(
        'peer',
        !!selected && !given && (selected[0] === r || selected[1] === c ||
          (Math.floor(selected[0] / 3) === Math.floor(r / 3) && Math.floor(selected[1] / 3) === Math.floor(c / 3)))
      );
      cell.classList.toggle('same-value', !!selectedValue && value === selectedValue);

      const wrong = !given && value !== 0 && value !== state.solution[r][c];
      cell.classList.toggle('error', wrong || conflicts.has(key));

      const isFewest = !!fewest.cells && fewest.cells.has(key);
      cell.classList.toggle('fewest-hint', isFewest);
      cell.classList.toggle('contradiction', isFewest && fewest.count === 0);

      if (value !== 0) {
        cell.textContent = String(value);
        continue;
      }

      const showAutoCandidates =
        state.candidateMode === 'all' ||
        (state.candidateMode === 'selected' && !!selected && selected[0] === r && selected[1] === c);

      if (showAutoCandidates) {
        cell.replaceChildren(buildNotesGrid(candidates[r][c], 'auto'));
      } else if (state.notes[r][c].size > 0) {
        cell.replaceChildren(buildNotesGrid(state.notes[r][c]));
      } else {
        cell.replaceChildren();
      }

      if (isFewest) {
        const badge = document.createElement('span');
        badge.className = fewest.count === 0 ? 'candidate-badge contradiction' : 'candidate-badge';
        badge.textContent = String(candidates[r][c].length);
        cell.appendChild(badge);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------

function showLoading(text) {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}
function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

function statRow(label, valueText, tone) {
  return `<dt>${label}</dt><dd class="${tone || ''}">${valueText}</dd>`;
}

function showWinOverlay({ bestBefore, avgBefore }) {
  if (state.autoSolved) {
    winStats.innerHTML = statRow('Result', 'Auto-solved', 'muted');
    winFootnote.textContent =
      'Solved with the "Solve" button — this run isn’t counted toward your time stats, best times, or the performance estimate below.';
    winOverlay.classList.remove('hidden');
    return;
  }

  const rows = [];
  rows.push(statRow('Time', formatDuration(state.elapsedMs)));
  rows.push(statRow('Mistakes', String(state.mistakes), state.mistakes === 0 ? 'good' : ''));

  if (bestBefore) {
    const diff = state.elapsedMs - bestBefore.durationMs;
    if (diff <= 0) rows.push(statRow('Vs. your best (this puzzle)', `New best! (was ${formatDuration(bestBefore.durationMs)})`, 'good'));
    else rows.push(statRow('Vs. your best (this puzzle)', `+${formatDuration(diff)} slower`, 'bad'));
  } else {
    rows.push(statRow('Vs. your best (this puzzle)', 'First completion'));
  }

  if (avgBefore) {
    const diff = state.elapsedMs - avgBefore;
    const tone = diff <= 0 ? 'good' : 'bad';
    const sign = diff <= 0 ? '−' : '+';
    rows.push(statRow(`Vs. your ${state.difficulty} average`, `${sign}${formatDuration(Math.abs(diff))}`, tone));
  }

  const estimate = estimatePerformance(state.difficulty, state.elapsedMs);
  rows.push(statRow(
    'Est. vs. other players *',
    `faster than ~${estimate.outperformedPct}% (modeled)`,
    estimate.outperformedPct >= 50 ? 'good' : 'bad'
  ));

  winStats.innerHTML = rows.join('');
  winFootnote.textContent =
    '* No real worldwide data is collected — this is a rough estimate from a typical ' +
    `solving-time distribution for ${state.difficulty} puzzles (median ~${formatDuration(estimate.medianMs)}), not other players’ actual results.`;
  winOverlay.classList.remove('hidden');
}

function hideWinOverlay() {
  winOverlay.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// History panel
// ---------------------------------------------------------------------------

function openHistoryPanel() {
  renderHistoryPanel();
  historyPanel.classList.remove('hidden');
  historyBackdrop.classList.remove('hidden');
}
function closeHistoryPanel() {
  historyPanel.classList.add('hidden');
  historyBackdrop.classList.add('hidden');
}

function renderHistoryPanel() {
  const stats = store.getOverallStats();
  overallStats.innerHTML = `
    <span class="tag">Stored puzzles: ${stats.puzzlesStored}</span>
    <span class="tag">Completed: ${stats.completedCount}</span>
  `;

  const games = store.listGames();
  if (!games.length) {
    historyList.innerHTML = '<p class="history-empty">No puzzles yet — start a new game.</p>';
    return;
  }

  historyList.innerHTML = '';
  for (const game of games) {
    const best = store.getBestAttempt(game.id);
    const completedAttempts = game.attempts.filter((a) => a.completed && !a.autoSolved).length;
    const inProgress = game.attempts.find((a) => !a.completed);
    const date = new Date(game.createdAt).toLocaleString();

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <div class="history-item-top">
        <strong>${game.difficulty}</strong>
        <span class="tag">${game.source === 'web' ? '🌐 web' : '💻 local'}</span>
      </div>
      <div class="history-item-meta">
        ${date} · ${game.clues} clues · ${completedAttempts} completed attempt${completedAttempts === 1 ? '' : 's'}
        ${best ? ` · best ${formatDuration(best.durationMs)}` : ''}
      </div>
      <div class="history-item-actions">
        <button class="resume-btn">${inProgress && game.id === state.gameId ? 'Current' : inProgress ? 'Resume' : 'Play again'}</button>
        <button class="danger delete-btn">Delete</button>
      </div>
    `;

    item.querySelector('.resume-btn').addEventListener('click', () => {
      hideWinOverlay();
      if (inProgress) {
        applyGame(game, inProgress);
      } else {
        const attempt = store.startAttempt(game.id);
        applyGame(store.getGame(game.id), attempt);
      }
      closeHistoryPanel();
    });
    item.querySelector('.delete-btn').addEventListener('click', () => {
      store.deleteGame(game.id);
      if (state.gameId === game.id) {
        state.gameId = null;
        startNewGame(state.difficulty, { online: onlineToggle.checked });
      }
      renderHistoryPanel();
    });

    historyList.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem('sudoku:theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  updateThemeIcon();
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('sudoku:theme', next);
  updateThemeIcon();
}
function updateThemeIcon() {
  const current = document.documentElement.getAttribute('data-theme') ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  themeToggle.textContent = current === 'dark' ? '☀️' : '🌙';
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

function updateSoundIcon() {
  soundToggle.textContent = sfx.isMuted() ? '🔇' : '🔊';
}
function toggleSound() {
  sfx.toggleMuted();
  updateSoundIcon();
}

// Audio contexts start suspended until a user gesture unlocks them.
window.addEventListener('pointerdown', sfx.init, { once: true });
window.addEventListener('keydown', sfx.init, { once: true });

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

diffButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    sfx.click();
    setActiveDifficultyButton(btn.dataset.difficulty);
  });
});

function setCandidateMode(mode) {
  state.candidateMode = mode;
  candButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  render();
}

function cycleCandidateMode() {
  const idx = CANDIDATE_MODES.indexOf(state.candidateMode);
  setCandidateMode(CANDIDATE_MODES[(idx + 1) % CANDIDATE_MODES.length]);
}

candButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    sfx.click();
    setCandidateMode(btn.dataset.mode);
  });
});

newGameBtn.addEventListener('click', () => {
  sfx.click();
  const difficulty = diffButtons.find((b) => b.classList.contains('active'))?.dataset.difficulty || 'normal';
  startNewGame(difficulty, { online: onlineToggle.checked });
});

retryBtn.addEventListener('click', () => {
  sfx.click();
  retryCurrentPuzzle();
});
playAgainBtn.addEventListener('click', () => {
  sfx.click();
  startNewGame(state.difficulty, { online: onlineToggle.checked });
});

notesBtn.addEventListener('click', () => {
  sfx.click();
  state.notesMode = !state.notesMode;
  notesBtn.setAttribute('aria-pressed', String(state.notesMode));
});

hintBtn.addEventListener('click', applyHint);
solveBtn.addEventListener('click', solvePuzzle);
resetBtn.addEventListener('click', () => {
  sfx.click();
  resetBoard();
});

numpad.addEventListener('click', (e) => {
  const btn = e.target.closest('.num-btn');
  if (!btn || !state.selected) return;
  const [r, c] = state.selected;
  setCellValue(r, c, Number(btn.dataset.num));
});

themeToggle.addEventListener('click', () => {
  sfx.click();
  toggleTheme();
});
soundToggle.addEventListener('click', toggleSound);
historyBtn.addEventListener('click', () => {
  sfx.click();
  openHistoryPanel();
});
closeHistoryBtn.addEventListener('click', () => {
  sfx.click();
  closeHistoryPanel();
});
historyBackdrop.addEventListener('click', closeHistoryPanel);
solverBtn.addEventListener('click', () => {
  sfx.click();
  openSolverPanel();
});
closeSolverBtn.addEventListener('click', () => {
  sfx.click();
  closeSolverPanel();
});
solverBackdrop.addEventListener('click', closeSolverPanel);

document.addEventListener('keydown', (e) => {
  if (!historyPanel.classList.contains('hidden') && e.key === 'Escape') {
    closeHistoryPanel();
    return;
  }
  if (!solverPanel.classList.contains('hidden') && e.key === 'Escape') {
    closeSolverPanel();
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
  if (e.key.toLowerCase() === 'n') {
    state.notesMode = !state.notesMode;
    notesBtn.setAttribute('aria-pressed', String(state.notesMode));
    return;
  }
  if (e.key.toLowerCase() === 'c') {
    cycleCandidateMode();
    return;
  }
  if (e.key === 'ArrowUp') { moveSelection(-1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowDown') { moveSelection(1, 0); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { moveSelection(0, -1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { moveSelection(0, 1); e.preventDefault(); }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  buildBoardDom();
  initTheme();
  updateSoundIcon();

  const pointer = store.getCurrentPointer();
  if (pointer && pointer.gameId) {
    const game = store.getGame(pointer.gameId);
    const attempt = game && store.getAttempt(pointer.gameId, pointer.attemptId);
    if (game && attempt && !attempt.completed) {
      applyGame(game, attempt);
      return;
    }
  }

  startNewGame('normal', { online: false });
}

boot();
