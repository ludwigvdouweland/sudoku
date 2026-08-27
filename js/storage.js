// storage.js
// Local-only puzzle history & performance tracking, backed by localStorage.
// No network calls happen here — everything works fully offline, and nothing
// here is ever compared against other users' data (there is no shared backend).

const HISTORY_KEY = 'sudoku:history:v1';
const CURRENT_KEY = 'sudoku:current:v1';
const MAX_ENTRIES = 200;

function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function readAll() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Sudoku history: failed to read localStorage', err);
    return [];
  }
}

function writeAll(entries) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(entries));
  } catch (err) {
    console.warn('Sudoku history: failed to write localStorage (quota exceeded?)', err);
  }
}

function saveGame(updated) {
  const entries = readAll();
  const idx = entries.findIndex((g) => g.id === updated.id);
  if (idx === -1) return;
  entries[idx] = updated;
  writeAll(entries);
}

/** Remembers which game/attempt is "active", so a page reload can offer to resume it. */
export function setCurrentPointer(gameId, attemptId) {
  try {
    localStorage.setItem(CURRENT_KEY, JSON.stringify({ gameId, attemptId }));
  } catch (err) {
    console.warn('Sudoku history: failed to persist current pointer', err);
  }
}

export function getCurrentPointer() {
  try {
    const raw = localStorage.getItem(CURRENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function createGameRecord({ puzzle, solution, difficulty, source, clues }) {
  const entries = readAll();
  const record = {
    id: generateId(),
    difficulty,
    source,
    clues,
    puzzle,
    solution,
    createdAt: new Date().toISOString(),
    attempts: [],
  };
  entries.unshift(record);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  writeAll(entries);
  return record;
}

export function getGame(id) {
  return readAll().find((g) => g.id === id) || null;
}

export function listGames() {
  return readAll();
}

export function deleteGame(id) {
  writeAll(readAll().filter((g) => g.id !== id));
  const current = getCurrentPointer();
  if (current && current.gameId === id) setCurrentPointer(null, null);
}

export function startAttempt(gameId) {
  const game = getGame(gameId);
  if (!game) return null;
  const attempt = {
    id: generateId(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    elapsedMs: 0,
    durationMs: null,
    mistakes: 0,
    completed: false,
    autoSolved: false, // true if finished via the "Solve" button — excluded from stats/comparisons
    board: null, // snapshot of entered values, for resuming
    notes: null, // snapshot of pencil marks, for resuming
  };
  game.attempts.unshift(attempt);
  saveGame(game);
  setCurrentPointer(gameId, attempt.id);
  return attempt;
}

export function getAttempt(gameId, attemptId) {
  const game = getGame(gameId);
  if (!game) return null;
  return game.attempts.find((a) => a.id === attemptId) || null;
}

export function updateAttemptProgress(gameId, attemptId, { board, notes, mistakes, elapsedMs }) {
  const game = getGame(gameId);
  if (!game) return;
  const attempt = game.attempts.find((a) => a.id === attemptId);
  if (!attempt) return;
  if (board) attempt.board = board;
  if (notes) attempt.notes = notes;
  if (typeof mistakes === 'number') attempt.mistakes = mistakes;
  if (typeof elapsedMs === 'number') attempt.elapsedMs = elapsedMs;
  saveGame(game);
}

export function completeAttempt(gameId, attemptId, { elapsedMs, mistakes, autoSolved = false }) {
  const game = getGame(gameId);
  if (!game) return null;
  const attempt = game.attempts.find((a) => a.id === attemptId);
  if (!attempt) return null;
  attempt.finishedAt = new Date().toISOString();
  attempt.elapsedMs = elapsedMs;
  attempt.durationMs = elapsedMs;
  attempt.mistakes = mistakes;
  attempt.completed = true;
  attempt.autoSolved = autoSolved;
  saveGame(game);
  return { game, attempt };
}

// --- Stats / comparisons (derived entirely from local data — no other users involved) ---
// Auto-solved attempts (the "Solve" button) are excluded everywhere here: they'd
// otherwise pollute best-time / average stats with instant, not-actually-played times.

export function getBestAttempt(gameId, excludeAttemptId = null) {
  const game = getGame(gameId);
  if (!game) return null;
  const completed = game.attempts.filter((a) => a.completed && !a.autoSolved && a.id !== excludeAttemptId);
  if (!completed.length) return null;
  return completed.reduce((best, a) => (a.durationMs < best.durationMs ? a : best));
}

/** Average completion time (ms) across all completed puzzles of a given difficulty. */
export function getDifficultyAverage(difficulty, excludeAttemptId = null) {
  const games = readAll().filter((g) => g.difficulty === difficulty);
  const durations = [];
  for (const g of games) {
    for (const a of g.attempts) {
      if (a.completed && !a.autoSolved && a.id !== excludeAttemptId) durations.push(a.durationMs);
    }
  }
  if (!durations.length) return null;
  return durations.reduce((sum, d) => sum + d, 0) / durations.length;
}

export function getOverallStats() {
  const games = readAll();
  let completedCount = 0;
  const byDifficulty = { easy: 0, normal: 0, hard: 0 };
  for (const g of games) {
    for (const a of g.attempts) {
      if (a.completed && !a.autoSolved) {
        completedCount += 1;
        byDifficulty[g.difficulty] = (byDifficulty[g.difficulty] || 0) + 1;
      }
    }
  }
  return { puzzlesStored: games.length, completedCount, byDifficulty };
}
