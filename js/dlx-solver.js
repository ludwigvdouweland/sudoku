// dlx-solver.js
// Dancing Links (Knuth's Algorithm X) -- a fifth Sudoku-solving paradigm,
// alongside the hand-written MRV backtracking search in sudoku-engine.js,
// the constraint-propagation solver in cp-solver.js, and the two MILP
// formulations in milp-solver.js. Pure logic, no DOM access, fully
// synchronous (no WASM to load).
//
// Sudoku is an *exact cover* problem: choose a subset of candidate
// (cell, digit) placements such that every constraint ("this cell holds a
// digit", "this row holds this digit", "this column holds this digit",
// "this box holds this digit") is satisfied by exactly one chosen
// candidate. That's precisely the structure `solveGridMILPBinary()` in
// milp-solver.js encodes as a 0/1 integer program and hands to HiGHS's
// LP-relaxation + branch-and-cut solver. This module solves the *same*
// exact-cover matrix directly, with no relaxation at all: Knuth's Algorithm
// X, using the "Dancing Links" (DLX) data structure to make the
// backtracking search's choose/undo steps O(1) per affected cell instead of
// O(matrix size).
//
// The matrix: rows = candidate placements (cell r,c holds digit v), columns
// = constraints. Each row has exactly 4 ones -- it satisfies exactly one
// cell constraint, one row-digit constraint, one column-digit constraint,
// and one box-digit constraint. "Solve the puzzle" = pick a set of rows
// that between them cover every column exactly once.
//
//   Column 0..80:    cell(r,c)      -- this cell holds some digit
//   Column 81..161:  row(r,v)       -- this row holds digit v somewhere
//   Column 162..242: col(c,v)       -- this column holds digit v somewhere
//   Column 243..323: box(b,v)       -- this box holds digit v somewhere
//
// A given clue is encoded simply by only generating *one* candidate row for
// that cell (its given digit) instead of nine -- no special-casing needed
// beyond that; an invalid/contradictory set of givens falls out as a
// column that some row can no longer reach, same as any other dead end.
//
// The search itself is standard Algorithm X: repeatedly pick the column
// with the fewest candidate rows left (Knuth's "S" heuristic -- this is the
// same minimum-remaining-values idea as the MRV backtracking solver, just
// applied to constraints instead of cells), try each candidate row for it,
// "cover" (remove) every column that row satisfies and cascade-remove every
// other row that conflicts with it, and recurse. Every column header and
// data cell lives in two circular doubly-linked lists (one horizontal
// across columns, one vertical within a column) -- "covering" a column
// unlinks nodes by rewriting a handful of neighbor pointers, and
// "uncovering" restores them by replaying the exact same links in reverse,
// which is only possible/correct because nothing else was ever *deleted*,
// just spliced out. That's the "dancing" in Dancing Links, and it's what
// makes undoing a choice O(1) per removed node rather than requiring any
// search or reconstruction.

import { SIZE, BOX, emptyGrid } from './sudoku-engine.js';

const CELL_BASE = 0;
const ROW_BASE = SIZE * SIZE; // 81
const COL_BASE = 2 * SIZE * SIZE; // 162
const BOX_BASE = 3 * SIZE * SIZE; // 243
const NUM_COLUMNS = 4 * SIZE * SIZE; // 324

// Removes column `col` from the horizontal header ring, and every row that
// has a node in `col` from every *other* column it touches -- i.e. every
// candidate placement that would conflict with `col` ever being satisfied
// again becomes unreachable. Mutates the shared link structure in place.
function cover(col) {
  col.right.left = col.left;
  col.left.right = col.right;
  for (let row = col.down; row !== col; row = row.down) {
    for (let node = row.right; node !== row; node = node.right) {
      node.down.up = node.up;
      node.up.down = node.down;
      node.column.size--;
    }
  }
}

// Exact mirror of cover(), run in reverse order, restoring every pointer it
// touched -- correct because cover() never discarded a node, only spliced
// it out, so every neighbor pointer it overwrote is still sitting there to
// replay.
function uncover(col) {
  for (let row = col.up; row !== col; row = row.up) {
    for (let node = row.left; node !== row; node = node.left) {
      node.column.size++;
      node.down.up = node;
      node.up.down = node;
    }
  }
  col.right.left = col;
  col.left.right = col;
}

// Solves `grid` (9x9, 0 = empty) via Dancing Links / Algorithm X. Returns
// the solved grid, or null if the exact-cover matrix has no solution
// (including malformed input, e.g. givens that already conflict).
export function solveGridDLX(grid) {
  const root = {};
  root.left = root;
  root.right = root;

  const headers = new Array(NUM_COLUMNS);
  for (let i = 0; i < NUM_COLUMNS; i++) {
    const header = { size: 0 };
    header.up = header;
    header.down = header;
    // Insert at the tail of the horizontal header ring.
    header.left = root.left;
    header.right = root;
    root.left.right = header;
    root.left = header;
    headers[i] = header;
  }

  // Appends one candidate row (a 4-element ring, one node per constraint it
  // satisfies) linked into its four columns' vertical lists.
  function addCandidateRow(columnIndices, placement) {
    let first = null;
    let prev = null;
    for (const colIndex of columnIndices) {
      const header = headers[colIndex];
      const node = { column: header, placement };
      node.up = header.up;
      node.down = header;
      header.up.down = node;
      header.up = node;
      header.size++;

      if (!first) {
        first = node;
        node.left = node;
        node.right = node;
      } else {
        node.left = prev;
        node.right = first;
        prev.right = node;
        first.left = node;
      }
      prev = node;
    }
  }

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const given = grid[r][c];
      const box = Math.floor(r / BOX) * BOX + Math.floor(c / BOX);
      // A given clue only ever gets *one* candidate row -- that's the whole
      // encoding of "this cell is fixed", no special-casing needed elsewhere.
      const candidates = given ? [given] : [1, 2, 3, 4, 5, 6, 7, 8, 9];
      for (const v of candidates) {
        addCandidateRow(
          [
            CELL_BASE + r * SIZE + c,
            ROW_BASE + r * SIZE + (v - 1),
            COL_BASE + c * SIZE + (v - 1),
            BOX_BASE + box * SIZE + (v - 1),
          ],
          { r, c, v }
        );
      }
    }
  }

  const solution = [];

  function search() {
    if (root.right === root) return true; // every column satisfied -> solved

    // Knuth's "S" heuristic: branch on the least-satisfiable constraint
    // first -- same minimum-remaining-values idea as the MRV backtracking
    // solver, applied to constraints instead of cells. A size-0 column
    // means some constraint has no candidate left at all -- dead end.
    let col = root.right;
    for (let c = root.right; c !== root; c = c.right) {
      if (c.size < col.size) col = c;
    }
    if (col.size === 0) return false;

    cover(col);
    for (let row = col.down; row !== col; row = row.down) {
      solution.push(row.placement);
      for (let node = row.right; node !== row; node = node.right) cover(node.column);

      if (search()) return true;

      solution.pop();
      for (let node = row.left; node !== row; node = node.left) uncover(node.column);
    }
    uncover(col);
    return false;
  }

  if (!search()) return null;

  const out = emptyGrid();
  for (const { r, c, v } of solution) out[r][c] = v;
  return out;
}
