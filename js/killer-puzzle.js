// killer-puzzle.js
// The one Killer Sudoku puzzle the Killer page plays: a puzzle-book page
// ("Carnival" story), transcribed from the reference photos. Variant rules on
// top of classic Killer:
//   - both main diagonals must also contain 1-9 (Killer-X), and
//   - the "boxes" are irregular jigsaw regions, not 3x3 blocks.
// The photo's grey/yellow/green cell shading belongs to the story's
// answer-extraction meta-puzzle, not to the solving rules, so it's left out.
//
// Transcription was machine-checked against the photo (region lines by line
// thickness, cage outlines by the dashed insets on every cell edge), and the
// resulting puzzle has exactly one solution.

// One letter per cell, row by row: cells sharing a letter form one region.
const REGIONS = [
  'AAAABBBBB',
  'AACCBBBDB',
  'ACCCDDDDD',
  'AECCCCDDD',
  'AEFFFFFFF',
  'EEEFGGGGG',
  'EEHFGIIIG',
  'EHHGGIIII',
  'EHHHHHHII',
];

// [sum, cells] with cells as 1-based "RC" pairs, e.g. '11 21' = r1c1 + r2c1.
const CAGES = [
  [12, '11 21'], [15, '12 22'], [14, '13 14 24'], [13, '15 25 35'],
  [9, '16 26'], [9, '17 27'], [7, '18 28'], [14, '19 29'],
  [4, '23 33'], [13, '31 32 41 42'], [14, '34 44'], [9, '36 46'],
  [11, '37 47'], [15, '38 48'], [7, '39 49'], [10, '43 53'],
  [7, '45 55'], [11, '51 52'], [14, '54 64'], [12, '56 57'],
  [13, '58 59'], [14, '61 71'], [3, '62 72'], [11, '63 73'],
  [18, '65 66 67'], [4, '68 69'], [7, '74 84'], [20, '75 85 86'],
  [13, '76 77'], [8, '78 88'], [10, '79 89'], [18, '81 82 83'],
  [14, '87 95 96 97'], [10, '91 92'], [10, '93 94'], [12, '98 99'],
];

export const PUZZLE = {
  id: 'carnival-killer-x-jigsaw',
  diagonals: true,
  regions: REGIONS.map((row) => Array.from(row, (ch) => ch.charCodeAt(0) - 65)),
  cages: CAGES.map(([sum, cells]) => ({
    sum,
    cells: cells.split(' ').map((rc) => [Number(rc[0]) - 1, Number(rc[1]) - 1]),
  })),
};
