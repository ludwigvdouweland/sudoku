// killer-logic.js
// Pure Killer Sudoku rule logic for the Killer page: builds the constraint
// model (rows, columns, jigsaw regions, optional diagonals, cages) from a
// puzzle definition and derives decision-support information from a board.
// There's deliberately no search/solver here — everything is a direct
// consequence of the rules and the digits currently on the board, the same
// deductions a human would make with pencil marks. No DOM access.
//
// Digit sets are 9-bit masks throughout: bit (d - 1) set <=> digit d present.

export const SIZE = 9;
export const ALL_DIGITS = 0x1ff;

export const bit = (d) => 1 << (d - 1);

export function maskToDigits(mask) {
  const digits = [];
  for (let d = 1; d <= 9; d++) if (mask & bit(d)) digits.push(d);
  return digits;
}

function popcount(mask) {
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

function maskSum(mask) {
  let s = 0;
  for (let d = 1; d <= 9; d++) if (mask & bit(d)) s += d;
  return s;
}

// SUBSETS[k][sum] = every k-digit set (as a mask) whose digits add up to `sum`.
const SUBSETS = Array.from({ length: 10 }, () => Array.from({ length: 46 }, () => []));
for (let mask = 0; mask <= ALL_DIGITS; mask++) SUBSETS[popcount(mask)][maskSum(mask)].push(mask);

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Builds the constraint model for a puzzle and validates its shape (throws if
 * regions aren't 9x9 cells each or cages don't tile the grid exactly once).
 */
export function buildModel(puzzle) {
  const units = [];
  for (let r = 0; r < SIZE; r++) {
    units.push({ kind: 'row', label: `Row ${r + 1}`, cells: Array.from({ length: SIZE }, (_, c) => [r, c]) });
  }
  for (let c = 0; c < SIZE; c++) {
    units.push({ kind: 'col', label: `Column ${c + 1}`, cells: Array.from({ length: SIZE }, (_, r) => [r, c]) });
  }

  const regionCells = Array.from({ length: SIZE }, () => []);
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) regionCells[puzzle.regions[r][c]].push([r, c]);
  }
  regionCells.forEach((cells, i) => {
    if (cells.length !== SIZE) throw new Error(`Region ${i + 1} has ${cells.length} cells, expected 9`);
    units.push({ kind: 'region', label: `Region ${i + 1}`, cells });
  });

  if (puzzle.diagonals) {
    units.push({ kind: 'diag', label: 'Diagonal ↘', cells: Array.from({ length: SIZE }, (_, i) => [i, i]) });
    units.push({ kind: 'diag', label: 'Diagonal ↙', cells: Array.from({ length: SIZE }, (_, i) => [i, SIZE - 1 - i]) });
  }

  const unitsOf = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => []));
  units.forEach((unit, i) => unit.cells.forEach(([r, c]) => unitsOf[r][c].push(i)));

  // Cages, each with its head cell (first in reading order — where the sum is printed).
  const cageOf = Array.from({ length: SIZE }, () => Array(SIZE).fill(-1));
  let total = 0;
  const cages = puzzle.cages.map((cage, i) => {
    const cells = cage.cells.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [r, c] of cells) {
      if (cageOf[r][c] !== -1) throw new Error(`Cell r${r + 1}c${c + 1} is in two cages`);
      cageOf[r][c] = i;
    }
    total += cage.sum;
    return { sum: cage.sum, cells, head: cells[0] };
  });
  if (cageOf.flat().includes(-1)) throw new Error('Cages do not cover every cell');
  if (total !== 405) throw new Error(`Cage sums total ${total}, expected 405`);

  return { puzzle, units, unitsOf, regionOf: puzzle.regions, cages, cageOf };
}

// ---------------------------------------------------------------------------
// Board analysis
// ---------------------------------------------------------------------------

/** Mask of digits placed in `cells` (optionally skipping one cell). */
function placedMask(board, cells, skip = null) {
  let mask = 0;
  for (const [r, c] of cells) {
    if (skip && skip[0] === r && skip[1] === c) continue;
    if (board[r][c]) mask |= bit(board[r][c]);
  }
  return mask;
}

/**
 * Candidate digits (masks) for every empty cell; filled cells get 0.
 * A digit survives if it isn't placed anywhere in the cell's row, column,
 * region, diagonal(s) or cage, AND the cage can still reach its sum with it:
 * some assignment of distinct digits to the cage's empty cells, each from
 * that cell's own remaining options, has to add up to what's left.
 */
export function computeCandidates(model, board) {
  const cand = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c]) continue;
      let used = 0;
      for (const u of model.unitsOf[r][c]) used |= placedMask(board, model.units[u].cells);
      used |= placedMask(board, model.cages[model.cageOf[r][c]].cells);
      cand[r][c] = ALL_DIGITS & ~used;
    }
  }

  for (const cage of model.cages) {
    const empty = cage.cells.filter(([r, c]) => !board[r][c]);
    if (!empty.length) continue;
    const placed = placedMask(board, cage.cells);
    const remaining = cage.sum - maskSum(placed);
    const reachable = cageAssignments(empty.map(([r, c]) => cand[r][c]), remaining);
    empty.forEach(([r, c], i) => {
      cand[r][c] &= reachable[i];
    });
  }

  return cand;
}

/**
 * For cells with option masks `options`, returns per cell the digits that
 * occur in at least one assignment of distinct digits totalling `target`.
 * Cages are at most a handful of cells, so plain enumeration is instant.
 */
function cageAssignments(options, target) {
  const reachable = Array(options.length).fill(0);
  const chosen = [];
  (function assign(i, used, sum) {
    if (i === options.length) {
      if (sum === target) chosen.forEach((d, j) => { reachable[j] |= bit(d); });
      return;
    }
    for (let d = 1; d <= 9; d++) {
      if (!(options[i] & bit(d)) || (used & bit(d)) || sum + d > target) continue;
      chosen[i] = d;
      assign(i + 1, used | bit(d), sum + d);
    }
  })(0, 0, 0);
  return reachable;
}

/**
 * Rule violations on the current board:
 *  - cells: Set of "r,c" keys for digits repeated in a row/column/region/
 *    diagonal/cage,
 *  - cages: Set of cage indices whose placed digits already exceed the sum,
 *    or that are complete with the wrong total.
 */
export function findConflicts(model, board) {
  const cells = new Set();
  const groups = model.units.map((u) => u.cells).concat(model.cages.map((cg) => cg.cells));
  for (const group of groups) {
    const seen = new Map();
    for (const [r, c] of group) {
      const v = board[r][c];
      if (!v) continue;
      if (seen.has(v)) {
        cells.add(`${r},${c}`);
        cells.add(seen.get(v));
      } else {
        seen.set(v, `${r},${c}`);
      }
    }
  }

  const cages = new Set();
  model.cages.forEach((cage, i) => {
    let sum = 0;
    let full = true;
    for (const [r, c] of cage.cells) {
      if (board[r][c]) sum += board[r][c];
      else full = false;
    }
    if (sum > cage.sum || (full && sum !== cage.sum)) cages.add(i);
  });

  return { cells, cages };
}

/**
 * Decision-support summary of one cage: what's placed, what's left, and which
 * full digit sets are still possible given the board and the candidates.
 */
export function analyzeCage(model, board, cand, cageIndex) {
  const cage = model.cages[cageIndex];
  const size = cage.cells.length;
  const placed = placedMask(board, cage.cells);
  const placedSum = maskSum(placed);
  const empty = cage.cells.filter(([r, c]) => !board[r][c]);

  // Every digit set of the cage's size and sum, before looking at the board —
  // the "combination table" solvers learn by heart (e.g. 2 cells / 3 = {1,2}).
  const allCombos = SUBSETS[size][cage.sum] || [];

  // Still possible: contains every placed digit, and its other digits can be
  // spread over the empty cells using each cell's candidates.
  const combos = allCombos.filter((mask) => {
    if ((mask & placed) !== placed) return false;
    const rest = mask & ~placed;
    return canCover(empty.map(([r, c]) => cand[r][c] & rest), rest);
  });

  let mustContain = combos.length ? ALL_DIGITS : 0;
  for (const mask of combos) mustContain &= mask;
  mustContain &= ~placed;

  return {
    sum: cage.sum,
    size,
    placedSum,
    remaining: cage.sum - placedSum,
    emptyCount: empty.length,
    allCombos,
    combos,
    mustContain,
  };
}

// True if the cells (option masks) can take every digit of `digits` exactly once.
function canCover(options, digits) {
  if (options.length !== popcount(digits)) return false;
  return (function place(i, left) {
    if (i === options.length) return left === 0;
    for (let d = 1; d <= 9; d++) {
      if ((options[i] & left & bit(d)) && place(i + 1, left & ~bit(d))) return true;
    }
    return false;
  })(0, digits);
}

/**
 * Hidden singles for an empty cell: digits that, within one of the cell's
 * units, have no other place to go. Returns [{ unitIndex, digit }].
 */
export function hiddenSingles(model, board, cand, r, c) {
  if (board[r][c]) return [];
  const found = [];
  for (const u of model.unitsOf[r][c]) {
    const cells = model.units[u].cells;
    for (const d of maskToDigits(cand[r][c])) {
      const elsewhere = cells.some(([rr, cc]) => (rr !== r || cc !== c) && (board[rr][cc] === d || (cand[rr][cc] & bit(d))));
      if (!elsewhere) found.push({ unitIndex: u, digit: d });
    }
  }
  return found;
}

/**
 * The "rule of 45" for a unit: every unit holds 1-9 once, so it sums to 45.
 * Cages lying entirely inside the unit account for part of that; whatever
 * cells are left over must make up the rest. Returns { cells, sum } for
 * those leftover cells (cells is empty when inside-cages cover the unit).
 */
export function ruleOf45(model, unitIndex) {
  const cells = model.units[unitIndex].cells;
  const inUnit = new Set(cells.map(([r, c]) => `${r},${c}`));
  const covered = new Set();
  let sum = 45;
  for (const cage of model.cages) {
    if (!cage.cells.every(([r, c]) => inUnit.has(`${r},${c}`))) continue;
    sum -= cage.sum;
    cage.cells.forEach(([r, c]) => covered.add(`${r},${c}`));
  }
  return { cells: cells.filter(([r, c]) => !covered.has(`${r},${c}`)), sum };
}

/** Digits not yet placed in a unit. */
export function missingDigits(model, board, unitIndex) {
  return ALL_DIGITS & ~placedMask(board, model.units[unitIndex].cells);
}

export function isComplete(model, board) {
  if (board.some((row) => row.includes(0))) return false;
  const { cells, cages } = findConflicts(model, board);
  return cells.size === 0 && cages.size === 0;
}
