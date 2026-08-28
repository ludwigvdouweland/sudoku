// milp-solver.js
// Two MILP formulations of Sudoku, both solved by HiGHS
// (https://highs.dev, vendored as ./vendor/highs/ -- see that file for
// details) compiled to WebAssembly. These are alternatives to the
// hand-written MRV backtracking solver in sudoku-engine.js (solveGrid) --
// same job (given a 9x9 grid with 0 = empty, return a solved grid, or null
// if infeasible), different technique. Pure logic, no DOM access.
//
// Both formulations are pure feasibility problems (any solution is as good
// as any other), so the objective is just the constant `0`. HiGHS is a
// real industrial-grade solver (presolve, cutting planes, a proper
// branch-and-cut implementation) written in C++, unlike the pure-JS solver
// this module used previously (see git history) -- that alone took the
// binary formulation from minutes-plus (often not finishing) to a flat
// ~15-20ms regardless of difficulty. The integer formulation (see its own
// notes below) is usually fast too but has real variance -- it's occasionally
// slow (seconds) on hard puzzles. Full numbers in SOLVERS.md.
//
// HiGHS's JS API takes the model as CPLEX .lp format text (not JSON), and
// loading the WASM module (~3.4MB, see ./vendor/highs/highs.wasm) is
// asynchronous, so both exported functions here are async (solveGrid, by
// contrast, is synchronous). The module is fetched once and cached for the
// page's lifetime (see getHighs() below), so only the first call pays the
// load cost.

import { SIZE, BOX, emptyGrid } from './sudoku-engine.js';
import highsLoader from './vendor/highs/highs.js';

// The WASM module is loaded once and reused across calls.
let highsPromise = null;
function getHighs() {
  if (!highsPromise) {
    highsPromise = highsLoader({
      locateFile: (file) => new URL(`./vendor/highs/${file}`, import.meta.url).href,
    });
  }
  return highsPromise;
}

const DEFAULT_TIME_LIMIT_S = 10;

// Runs a CPLEX-LP-format model through HiGHS and returns its raw solution
// object, or null if it wasn't solved to optimality (infeasible, timed out,
// etc. -- for our pure feasibility models "optimal" just means "found a
// point satisfying every constraint").
async function solveLP(lpText, options = {}) {
  const highs = await getHighs();
  const result = highs.solve(lpText, { time_limit: options.timeLimitS || DEFAULT_TIME_LIMIT_S });
  return result.Status === 'Optimal' ? result : null;
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
// backs algorithms like Knuth's Dancing Links, and the one industrial MILP
// solvers solve essentially instantly thanks to presolve, cuts, and
// degeneracy-aware pivoting (which is exactly what HiGHS brings here).
// ---------------------------------------------------------------------------

export async function solveGridMILPBinary(grid, options = {}) {
  const xVar = (r, c, v) => `x_${r}_${c}_${v}`;

  const lines = ['Minimize', ' obj: 0', 'Subject To'];

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const terms = [];
      for (let v = 1; v <= 9; v++) terms.push(xVar(r, c, v));
      lines.push(` cell_${r}_${c}: ${terms.join(' + ')} = 1`);
    }
  }
  for (let v = 1; v <= 9; v++) {
    for (let r = 0; r < SIZE; r++) {
      const terms = [];
      for (let c = 0; c < SIZE; c++) terms.push(xVar(r, c, v));
      lines.push(` row_${r}_${v}: ${terms.join(' + ')} = 1`);
    }
    for (let c = 0; c < SIZE; c++) {
      const terms = [];
      for (let r = 0; r < SIZE; r++) terms.push(xVar(r, c, v));
      lines.push(` col_${c}_${v}: ${terms.join(' + ')} = 1`);
    }
    for (let br = 0; br < SIZE; br += BOX) {
      for (let bc = 0; bc < SIZE; bc += BOX) {
        const terms = [];
        for (let r = br; r < br + BOX; r++) {
          for (let c = bc; c < bc + BOX; c++) terms.push(xVar(r, c, v));
        }
        lines.push(` box_${br}_${bc}_${v}: ${terms.join(' + ')} = 1`);
      }
    }
  }

  // Fix every given clue directly in Bounds below rather than adding more
  // constraint rows -- `x = 1` there pins the variable exactly.
  const fixedBounds = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const given = grid[r][c];
      if (given) fixedBounds.push(` ${xVar(r, c, given)} = 1`);
    }
  }

  lines.push('Bounds', ...fixedBounds, 'Binaries');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      for (let v = 1; v <= 9; v++) lines.push(` ${xVar(r, c, v)}`);
    }
  }
  lines.push('End');

  const result = await solveLP(lines.join('\n'), options);
  if (!result) return null;

  const out = emptyGrid();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      for (let v = 1; v <= 9; v++) {
        if (Math.round(result.Columns[xVar(r, c, v)].Primal) === 1) {
          out[r][c] = v;
          break;
        }
      }
    }
  }
  return out;
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
// worst case y_j - y_i = 1 - 9 = -8, so the inequality still holds, not
// violated -- this off-by-one was caught by independently re-checking the
// constraint math against a known solution before this module existed).
//
// Pairs are deduplicated across row/column/box (a pair of cells in the same
// row *and* the same box would otherwise get two redundant copies of the
// same disjunction), leaving ~810 pairs -> ~810 auxiliary binaries and
// ~1620 extra constraints -- and pairs where both cells are already given
// are skipped entirely, since two fixed, distinct values need no
// disjunction to keep them apart.
//
// Net trade-off vs. the binary formulation above: 81 integer variables
// instead of 729 binaries, but up to ~810 auxiliary binaries and a *much*
// looser LP relaxation (big-M constraints are notoriously weak). That shows
// up in practice: across 5 runs per difficulty, this formulation averaged
// ~45ms (easy) to ~115ms (normal) to ~1.1s (hard) -- and hard puzzles (fewer
// givens -> more free-cell pairs -> more auxiliary binaries) occasionally
// spike hard, one run took 5.1s. The binary formulation above stayed a flat
// ~15-20ms regardless of difficulty. Kept here to demonstrate the
// formulation and that trade-off concretely, not as a recommendation --
// prefer solveGridMILPBinary if you actually need a fast MILP solve. See
// SOLVERS.md for the full comparison and the numbers behind this.
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

export async function solveGridMILPInteger(grid, options = {}) {
  const M = 9; // smallest safe big-M for a [1,9] domain -- see note above
  const yVar = (r, c) => `y_${r}_${c}`;

  const lines = ['Minimize', ' obj: 0', 'Subject To'];
  const binaryVars = [];

  allDifferentPairs().forEach(([[r1, c1], [r2, c2]], idx) => {
    // Both cells are already fixed by the puzzle's givens -- they're
    // guaranteed different by construction, so the disjunction has nothing
    // left to decide.
    if (grid[r1][c1] && grid[r2][c2]) return;

    const yi = yVar(r1, c1);
    const yj = yVar(r2, c2);
    const b = `b_${idx}`;
    binaryVars.push(b);

    // (A): y_i - y_j + M*b >= 1
    lines.push(` diff_${idx}_a: ${yi} - ${yj} + ${M} ${b} >= 1`);
    // (B): y_j - y_i - M*b >= 1 - M   (i.e. + M*(1-b) >= 1)
    lines.push(` diff_${idx}_b: ${yj} - ${yi} - ${M} ${b} >= ${1 - M}`);
  });

  lines.push('Bounds');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const given = grid[r][c];
      lines.push(given ? ` ${yVar(r, c)} = ${given}` : ` 1 <= ${yVar(r, c)} <= 9`);
    }
  }

  lines.push('Generals');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) lines.push(` ${yVar(r, c)}`);
  }

  if (binaryVars.length) {
    lines.push('Binaries', ...binaryVars.map((b) => ` ${b}`));
  }
  lines.push('End');

  const result = await solveLP(lines.join('\n'), options);
  if (!result) return null;

  const out = emptyGrid();
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      out[r][c] = Math.round(result.Columns[yVar(r, c)].Primal);
    }
  }
  return out;
}
