// cp-solver.js
// A Constraint Programming (CP) solver for Sudoku -- a third algorithmic
// paradigm alongside the hand-written MRV backtracking search in
// sudoku-engine.js (solveGrid) and the two MILP formulations in
// milp-solver.js. Pure logic, no DOM access, fully synchronous (no WASM to
// load, unlike the MILP solvers).
//
// Where MILP relaxes the problem into linear (in)equalities and leans on an
// LP-relaxation + branch-and-cut solver (HiGHS), CP never relaxes anything:
// it reasons directly over explicit finite domains ("candidate sets") using
// logical inference rules, only falling back to search when propagation
// alone can't decide a cell. And where the plain backtracking solver only
// checks "is this value locally safe right now?" at the moment a value is
// tried, CP proactively shrinks every affected cell's domain the instant any
// cell is fixed -- much closer to how a human solves with pencil marks, and
// it typically requires many fewer branch points because a lot of the board
// gets filled by pure deduction before any guessing happens.
//
// The propagation core below follows the classic algorithm from Peter
// Norvig's "Solving Every Sudoku Puzzle" (https://norvig.com/sudoku.html),
// re-expressed with 9-bit bitmask domains instead of Python sets/dicts for
// speed. Two rules, applied to a fixpoint via mutual recursion:
//
//   1. Naked singles: when a cell's domain is reduced to a single candidate,
//      that value is eliminated from every peer (same row/column/box). If a
//      peer's domain in turn collapses to one candidate, this cascades.
//   2. Hidden singles: whenever a candidate is removed from a cell, check
//      every unit that cell belongs to -- if some digit now has only one
//      possible cell left in that unit (even though that cell's own domain
//      still shows several candidates), it must go there.
//
// Together these two rules are strictly more powerful than naive arc
// consistency on a binary "not-equal" constraint (which is all the naked-
// single cascade alone would give you) -- rule 2 enforces a form of bounds
// consistency on the row/column/box AllDifferent constraints directly. Most
// puzzles (including every difficulty this app generates) are solved by
// propagation alone or with only a handful of branch points.
//
// When propagation stalls with more than one candidate left somewhere, the
// solver picks the cell with the fewest remaining candidates (MRV, same
// heuristic as sudoku-engine.js) and tries each one, re-running propagation
// from that assumption and recursing -- this "propagate, then branch, then
// propagate again" loop is what the CP literature calls MAC (Maintaining
// Arc Consistency).

import { SIZE, BOX, emptyGrid } from './sudoku-engine.js';

const FULL = (1 << 9) - 1; // bits 0..8 represent candidate digits 1..9

function bitFor(value) {
  return 1 << (value - 1);
}

// Lookup table: single-bit mask -> the digit it represents. Only ever
// indexed with a mask that's already known to have exactly one bit set.
const BIT_TO_VALUE = new Array(1 << 9);
for (let v = 1; v <= 9; v++) BIT_TO_VALUE[bitFor(v)] = v;

function popcount(mask) {
  let n = 0;
  while (mask) {
    mask &= mask - 1;
    n++;
  }
  return n;
}

// --- Precomputed board topology (units, peers) -- built once at module load ---

function cellIndex(r, c) {
  return r * SIZE + c;
}

function buildUnits() {
  const units = [];
  for (let r = 0; r < SIZE; r++) {
    units.push(Array.from({ length: SIZE }, (_, c) => cellIndex(r, c)));
  }
  for (let c = 0; c < SIZE; c++) {
    units.push(Array.from({ length: SIZE }, (_, r) => cellIndex(r, c)));
  }
  for (let br = 0; br < SIZE; br += BOX) {
    for (let bc = 0; bc < SIZE; bc += BOX) {
      const cells = [];
      for (let r = br; r < br + BOX; r++) {
        for (let c = bc; c < bc + BOX; c++) cells.push(cellIndex(r, c));
      }
      units.push(cells);
    }
  }
  return units;
}

const UNITS = buildUnits(); // 27 units (9 rows + 9 cols + 9 boxes), 9 cell indices each

// The 3 units (row, column, box) each cell belongs to.
const UNITS_OF_CELL = Array.from({ length: SIZE * SIZE }, () => []);
for (const unit of UNITS) {
  for (const idx of unit) UNITS_OF_CELL[idx].push(unit);
}

// All cells sharing a unit with a given cell, deduplicated, excluding itself
// (20 peers per cell on a standard 9x9 board).
const PEERS = Array.from({ length: SIZE * SIZE }, (_, idx) => {
  const set = new Set();
  for (const unit of UNITS_OF_CELL[idx]) {
    for (const c of unit) if (c !== idx) set.add(c);
  }
  return Array.from(set);
});

// --- Propagation core (Norvig's assign/eliminate, bitmask form) ---

// Eliminates a single candidate digit (as a bit) from cell `idx`'s domain,
// cascading both inference rules described above. Mutates `domains` in
// place. Returns false the instant any domain is driven empty or any unit
// is left with nowhere to place one of its digits (a contradiction) --
// callers must stop and unwind on false, since `domains` may be left
// partially updated.
function eliminate(domains, idx, bit) {
  if (!(domains[idx] & bit)) return true; // already gone, nothing to do

  domains[idx] &= ~bit;

  if (domains[idx] === 0) return false; // wiped out the last candidate

  // Naked single cascade: this cell now holds exactly one candidate ->
  // that value can't appear anywhere else in its row/column/box.
  if (popcount(domains[idx]) === 1) {
    const onlyBit = domains[idx];
    for (const peer of PEERS[idx]) {
      if (!eliminate(domains, peer, onlyBit)) return false;
    }
  }

  // Hidden single check: for every unit containing `idx`, see whether the
  // digit we just removed now has exactly one legal home left in that unit.
  for (const unit of UNITS_OF_CELL[idx]) {
    let onlyPlace = -1;
    let places = 0;
    for (const cell of unit) {
      if (domains[cell] & bit) {
        places++;
        onlyPlace = cell;
        if (places > 1) break;
      }
    }
    if (places === 0) return false; // this digit has nowhere left to go
    if (places === 1 && !assign(domains, onlyPlace, bit)) return false;
  }

  return true;
}

// Forces cell `idx` to digit `bit`, by eliminating every other candidate
// from its domain (each elimination cascades via eliminate() above).
function assign(domains, idx, bit) {
  const others = domains[idx] & ~bit;
  for (let v = 1; v <= 9; v++) {
    const b = bitFor(v);
    if (others & b) {
      if (!eliminate(domains, idx, b)) return false;
    }
  }
  return true;
}

// Picks the unsolved cell (domain size > 1) with the fewest remaining
// candidates -- same MRV heuristic as sudoku-engine.js's findBestEmptyCell.
// Returns -1 if every cell is already a singleton (solved).
function pickBranchCell(domains) {
  let best = -1;
  let bestCount = 10;
  for (let idx = 0; idx < SIZE * SIZE; idx++) {
    const count = popcount(domains[idx]);
    if (count > 1 && count < bestCount) {
      bestCount = count;
      best = idx;
      if (count === 2) break; // can't do meaningfully better than 2
    }
  }
  return best;
}

// Depth-first search with propagation at every node (MAC): try each
// remaining candidate for the most-constrained cell, re-propagate, recurse.
function search(domains) {
  const branchCell = pickBranchCell(domains);
  if (branchCell === -1) return domains; // every domain is a singleton -> solved

  for (let v = 1; v <= 9; v++) {
    const bit = bitFor(v);
    if (!(domains[branchCell] & bit)) continue;
    const trial = domains.slice();
    if (assign(trial, branchCell, bit)) {
      const result = search(trial);
      if (result) return result;
    }
  }
  return null; // every candidate for this cell led to a contradiction
}

// Solves `grid` (9x9, 0 = empty) via constraint propagation + MRV-guided
// backtracking search. Returns the solved grid, or null if the puzzle is
// infeasible (including malformed input, e.g. a duplicate value already
// conflicting among the givens).
export function solveGridCP(grid) {
  const domains = new Array(SIZE * SIZE).fill(FULL);

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const given = grid[r][c];
      if (given && !assign(domains, cellIndex(r, c), bitFor(given))) {
        return null; // givens are already contradictory
      }
    }
  }

  const solved = search(domains);
  if (!solved) return null;

  const out = emptyGrid();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      out[r][c] = BIT_TO_VALUE[solved[cellIndex(r, c)]];
    }
  }
  return out;
}
