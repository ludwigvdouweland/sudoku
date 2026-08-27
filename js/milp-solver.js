// milp-solver.js
// Two MILP formulations of Sudoku, both solved with the vendored
// `javascript-lp-solver` branch-and-bound/simplex engine (see
// ./vendor/lp-solver.js). These are alternatives to the hand-written MRV
// backtracking solver in sudoku-engine.js (solveGrid) -- same job (given a
// 9x9 grid with 0 = empty, return a solved grid, or null if infeasible /
// the solver couldn't finish in time), different technique. Pure logic, no
// DOM access.
//
// Both formulations are pure feasibility problems (any solution is as good
// as any other), so `optimize` is a dummy attribute name that no variable
// ever references -- every variable's cost defaults to 0, and the solver
// just has to find any point that satisfies every constraint.

import { SIZE, BOX, emptyGrid } from './sudoku-engine.js';
import solver from './vendor/lp-solver.js';

const DEFAULT_TIMEOUT_MS = 20000;

function extractGridOrNull(result, cellValue) {
  if (!result || !result.feasible || !result.isIntegral) return null;
  const out = emptyGrid();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      out[r][c] = cellValue(result, r, c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formulation 1: binary assignment -- 729 binary variables x_r_c_v.
//
//   x[r][c][v] = 1  iff cell (r,c) holds value v
//
//   sum_v x[r][c][v] = 1                     one value per cell
//   sum_c x[r][c][v] = 1                     each value once per row
//   sum_r x[r][c][v] = 1                     each value once per column
//   sum_{(r,c) in box} x[r][c][v] = 1        each value once per box
//   x[r][c][g] = 1                           fixed for every given clue g
//
// This is the standard "exact cover" ILP formulation -- the same one that
// backs algorithms like Knuth's Dancing Links. Its LP relaxation tends to
// already be near-integral for solvable Sudoku grids, so branch-and-bound
// usually needs very little branching in practice.
// ---------------------------------------------------------------------------

export function solveGridMILPBinary(grid, options = {}) {
  const variables = {};
  const constraints = {};
  const binaries = {};

  const cellC = (r, c) => `cell_${r}_${c}`;
  const rowC = (r, v) => `row_${r}_${v}`;
  const colC = (c, v) => `col_${c}_${v}`;
  const boxC = (br, bc, v) => `box_${br}_${bc}_${v}`;
  const givenC = (r, c) => `given_${r}_${c}`;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) constraints[cellC(r, c)] = { equal: 1 };
  }
  for (let v = 1; v <= 9; v++) {
    for (let r = 0; r < SIZE; r++) constraints[rowC(r, v)] = { equal: 1 };
    for (let c = 0; c < SIZE; c++) constraints[colC(c, v)] = { equal: 1 };
    for (let br = 0; br < SIZE; br += BOX) {
      for (let bc = 0; bc < SIZE; bc += BOX) constraints[boxC(br, bc, v)] = { equal: 1 };
    }
  }

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const br = r - (r % BOX);
      const bc = c - (c % BOX);
      for (let v = 1; v <= 9; v++) {
        const id = `x_${r}_${c}_${v}`;
        binaries[id] = 1;
        variables[id] = {
          [cellC(r, c)]: 1,
          [rowC(r, v)]: 1,
          [colC(c, v)]: 1,
          [boxC(br, bc, v)]: 1,
        };
      }
      const given = grid[r][c];
      if (given) {
        constraints[givenC(r, c)] = { equal: 1 };
        variables[`x_${r}_${c}_${given}`][givenC(r, c)] = 1;
      }
    }
  }

  const model = {
    optimize: 'feasibility',
    opType: 'min',
    constraints,
    variables,
    binaries,
    options: { timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS },
  };

  const result = solver.Solve(model);
  return extractGridOrNull(result, (res, r, c) => {
    for (let v = 1; v <= 9; v++) {
      if (Math.round(res[`x_${r}_${c}_${v}`] || 0) === 1) return v;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Formulation 2: integer cell variables -- 81 integer variables y_r_c, one
// per cell, holding the digit directly. No binary *decision* variables --
// but see the note below on why some binary *auxiliary* variables are
// unavoidable.
//
//   y[r][c] in {1,...,9}   the digit written in cell (r,c)
//
// "All values in a unit (row/column/box) are different" cannot be written
// as a linear (in)equality on integer variables alone: y_i != y_j is an
// inherently disjunctive condition (y_i <= y_j - 1  OR  y_i >= y_j + 1),
// and a linear constraint can't express "or". The standard fix is a
// big-M disjunction per pair of cells that share a unit:
//
//   y_i - y_j + M*b_ij       >= 1       (A)
//   y_j - y_i + M*(1-b_ij)   >= 1       (B)      b_ij in {0,1}
//
// b_ij = 0 makes (A) the binding constraint (forces y_i > y_j) while (B)
// goes slack; b_ij = 1 flips it (forces y_j > y_i, (A) goes slack). Either
// way y_i != y_j. M must be large enough that the "slack" side can never
// be violated by real values: the widest possible gap is 9 - 1 = 8, so
// M = 9 is the smallest safe choice (1 - M = -8 exactly matches the
// worst case y_j - y_i = 1 - 9 = -8, so the inequality still holds, not violated).
//
// Pairs are deduplicated across row/column/box (a pair of cells in the same
// row *and* the same box would otherwise get two redundant copies of the
// same disjunction), leaving ~810 pairs -> ~810 auxiliary binaries and
// ~1620 extra constraints.
//
// Net trade-off vs. the binary formulation above: 81 integer variables
// instead of 729 binaries, but ~810 auxiliary binaries and a *much* looser
// LP relaxation (big-M constraints are notoriously weak), so branch-and-
// bound typically explores far more nodes and this solver runs noticeably
// slower. It's included to show that trade-off, not because it's the
// better formulation -- the exact-cover assignment model is the one you'd
// actually want in practice.
// ---------------------------------------------------------------------------

function sudokuUnits() {
  const units = [];
  for (let r = 0; r < SIZE; r++) {
    units.push(Array.from({ length: SIZE }, (_, c) => [r, c]));
  }
  for (let c = 0; c < SIZE; c++) {
    units.push(Array.from({ length: SIZE }, (_, r) => [r, c]));
  }
  for (let br = 0; br < SIZE; br += BOX) {
    for (let bc = 0; bc < SIZE; bc += BOX) {
      const cells = [];
      for (let r = br; r < br + BOX; r++) {
        for (let c = bc; c < bc + BOX; c++) cells.push([r, c]);
      }
      units.push(cells);
    }
  }
  return units;
}

// Every unordered pair of cells that must differ, deduplicated, each
// oriented [lo, hi] by row-major index so row/column/box overlaps collapse
// into a single pair instead of being encoded twice.
function allDifferentPairs() {
  const seen = new Set();
  const pairs = [];
  for (const unit of sudokuUnits()) {
    for (let i = 0; i < unit.length; i++) {
      for (let j = i + 1; j < unit.length; j++) {
        const [r1, c1] = unit[i];
        const [r2, c2] = unit[j];
        const idx1 = r1 * SIZE + c1;
        const idx2 = r2 * SIZE + c2;
        const lo = idx1 < idx2 ? [r1, c1] : [r2, c2];
        const hi = idx1 < idx2 ? [r2, c2] : [r1, c1];
        const key = `${lo[0]},${lo[1]}|${hi[0]},${hi[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push([lo, hi]);
      }
    }
  }
  return pairs;
}

export function solveGridMILPInteger(grid, options = {}) {
  const M = 9; // smallest safe big-M for a [1,9] domain -- see note above
  const variables = {};
  const constraints = {};
  const ints = {};
  const binaries = {};

  const cellVar = (r, c) => `y_${r}_${c}`;
  const boundC = (r, c) => `bound_${r}_${c}`;

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const id = cellVar(r, c);
      ints[id] = 1;
      variables[id] = {};
      const given = grid[r][c];
      constraints[boundC(r, c)] = given ? { equal: given } : { min: 1, max: 9 };
      variables[id][boundC(r, c)] = 1;
    }
  }

  allDifferentPairs().forEach(([[r1, c1], [r2, c2]], idx) => {
    // Both cells are already fixed by the puzzle's givens -- they're
    // guaranteed different by construction, so the disjunction has nothing
    // left to decide. Skipping these keeps the model's size proportional to
    // how many cells are still unsolved instead of always paying for all
    // ~810 pairs regardless of how few cells are actually free.
    if (grid[r1][c1] && grid[r2][c2]) return;

    const yi = cellVar(r1, c1);
    const yj = cellVar(r2, c2);
    const b = `b_${idx}`;
    binaries[b] = 1;
    variables[b] = {};

    const nameA = `diff_${idx}_a`;
    const nameB = `diff_${idx}_b`;
    constraints[nameA] = { min: 1 };
    constraints[nameB] = { min: 1 - M };

    // (A): y_i - y_j + M*b >= 1
    variables[yi][nameA] = 1;
    variables[yj][nameA] = -1;
    variables[b][nameA] = M;

    // (B): y_j - y_i - M*b >= 1 - M   (i.e. + M*(1-b) >= 1)
    variables[yi][nameB] = -1;
    variables[yj][nameB] = 1;
    variables[b][nameB] = -M;
  });

  const model = {
    optimize: 'feasibility',
    opType: 'min',
    constraints,
    variables,
    ints,
    binaries,
    options: { timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS },
  };

  const result = solver.Solve(model);
  return extractGridOrNull(result, (res, r, c) => Math.round(res[cellVar(r, c)] || 0));
}
