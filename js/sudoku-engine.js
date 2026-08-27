// sudoku-engine.js
// Pure Sudoku logic: generation, solving, validation. No DOM access here.

export const SIZE = 9;
export const BOX = 3;

export function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
}

export function cloneGrid(grid) {
  return grid.map((row) => row.slice());
}

export function gridsEqual(a, b) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (a[r][c] !== b[r][c]) return false;
    }
  }
  return true;
}

export function isSafe(grid, row, col, num) {
  for (let i = 0; i < SIZE; i++) {
    if (grid[row][i] === num || grid[i][col] === num) return false;
  }
  const boxRow = row - (row % BOX);
  const boxCol = col - (col % BOX);
  for (let r = 0; r < BOX; r++) {
    for (let c = 0; c < BOX; c++) {
      if (grid[boxRow + r][boxCol + c] === num) return false;
    }
  }
  return true;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// --- Fast full-grid generation (randomized, first-empty-cell order is fine here) ---

function findFirstEmpty(grid) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (grid[r][c] === 0) return [r, c];
    }
  }
  return null;
}

function fillGridRandomly(grid) {
  const pos = findFirstEmpty(grid);
  if (!pos) return true;
  const [row, col] = pos;
  const numbers = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const num of numbers) {
    if (isSafe(grid, row, col, num)) {
      grid[row][col] = num;
      if (fillGridRandomly(grid)) return true;
      grid[row][col] = 0;
    }
  }
  return false;
}

export function generateSolvedGrid() {
  const grid = emptyGrid();
  fillGridRandomly(grid);
  return grid;
}

// --- MRV-heuristic backtracking used for solving / uniqueness checks (much faster
// on sparse grids than naive first-empty-cell search) ---

function countCandidates(grid, row, col) {
  let count = 0;
  for (let num = 1; num <= 9; num++) {
    if (isSafe(grid, row, col, num)) count++;
  }
  return count;
}

// Finds the empty cell with the fewest legal candidates (Minimum Remaining Values).
// Returns null if the grid is full, or [row, col, 0] if some empty cell has no
// legal candidate at all (dead end -> caller should fail fast).
function findBestEmptyCell(grid) {
  let best = null;
  let bestCount = 10;
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (grid[r][c] !== 0) continue;
      const cnt = countCandidates(grid, r, c);
      if (cnt === 0) return [r, c, 0];
      if (cnt < bestCount) {
        bestCount = cnt;
        best = [r, c, cnt];
        if (cnt === 1) return best;
      }
    }
  }
  return best;
}

export function solveGrid(grid) {
  const g = cloneGrid(grid);

  function backtrack() {
    const cell = findBestEmptyCell(g);
    if (!cell) return true;
    const [row, col, cnt] = cell;
    if (cnt === 0) return false;
    for (let num = 1; num <= 9; num++) {
      if (isSafe(g, row, col, num)) {
        g[row][col] = num;
        if (backtrack()) return true;
        g[row][col] = 0;
      }
    }
    return false;
  }

  return backtrack() ? g : null;
}

// Counts solutions up to `limit` (default 2, which is all a uniqueness check needs).
export function countSolutions(grid, limit = 2) {
  const g = cloneGrid(grid);
  let count = 0;

  function backtrack() {
    if (count >= limit) return;
    const cell = findBestEmptyCell(g);
    if (!cell) {
      count++;
      return;
    }
    const [row, col, cnt] = cell;
    if (cnt === 0) return;
    for (let num = 1; num <= 9; num++) {
      if (count >= limit) return;
      if (isSafe(g, row, col, num)) {
        g[row][col] = num;
        backtrack();
        g[row][col] = 0;
      }
    }
  }

  backtrack();
  return count;
}

// Target clue-count ranges per difficulty. A random target within the range is
// picked each game for variety; fewer clues == harder.
export const DIFFICULTY_CLUE_RANGE = {
  easy: [38, 45],
  normal: [30, 37],
  hard: [24, 29],
};

export function generatePuzzle(difficulty = 'normal') {
  const solution = generateSolvedGrid();
  const puzzle = cloneGrid(solution);

  const [min, max] = DIFFICULTY_CLUE_RANGE[difficulty] || DIFFICULTY_CLUE_RANGE.normal;
  const target = min + Math.floor(Math.random() * (max - min + 1));

  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) cells.push([r, c]);
  }
  shuffle(cells);

  let clues = 81;
  for (const [row, col] of cells) {
    if (clues <= target) break;
    const backup = puzzle[row][col];
    if (backup === 0) continue;

    puzzle[row][col] = 0;
    if (countSolutions(puzzle, 2) === 1) {
      clues -= 1;
    } else {
      puzzle[row][col] = backup;
    }
  }

  return { puzzle, solution, clues, difficulty };
}

// Returns a 9x9 array where each empty cell holds the sorted list of values
// (1-9) that don't currently conflict with its row/column/box; filled cells
// get an empty array. Purely a function of the current board — independent
// of any particular solution — so it stays valid for wrong-but-locally-legal
// entries too, same as a human solving with pencil marks would see.
export function computeCandidates(board) {
  const grid = [];
  for (let r = 0; r < SIZE; r++) {
    const row = [];
    for (let c = 0; c < SIZE; c++) {
      if (board[r][c] !== 0) {
        row.push([]);
        continue;
      }
      const options = [];
      for (let n = 1; n <= 9; n++) {
        if (isSafe(board, r, c, n)) options.push(n);
      }
      row.push(options);
    }
    grid.push(row);
  }
  return grid;
}

// Returns a Set of "row,col" keys for every filled cell that duplicates a value
// somewhere in its row, column, or 3x3 box.
export function findConflicts(grid) {
  const conflicts = new Set();

  for (let r = 0; r < SIZE; r++) {
    const seen = new Map();
    for (let c = 0; c < SIZE; c++) {
      const v = grid[r][c];
      if (!v) continue;
      if (seen.has(v)) {
        conflicts.add(`${r},${c}`);
        conflicts.add(`${r},${seen.get(v)}`);
      } else {
        seen.set(v, c);
      }
    }
  }

  for (let c = 0; c < SIZE; c++) {
    const seen = new Map();
    for (let r = 0; r < SIZE; r++) {
      const v = grid[r][c];
      if (!v) continue;
      if (seen.has(v)) {
        conflicts.add(`${r},${c}`);
        conflicts.add(`${seen.get(v)},${c}`);
      } else {
        seen.set(v, r);
      }
    }
  }

  for (let br = 0; br < SIZE; br += BOX) {
    for (let bc = 0; bc < SIZE; bc += BOX) {
      const seen = new Map();
      for (let r = br; r < br + BOX; r++) {
        for (let c = bc; c < bc + BOX; c++) {
          const v = grid[r][c];
          if (!v) continue;
          const key = `${r},${c}`;
          if (seen.has(v)) {
            conflicts.add(key);
            conflicts.add(seen.get(v));
          } else {
            seen.set(v, key);
          }
        }
      }
    }
  }

  return conflicts;
}
