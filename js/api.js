// api.js
// Optional online puzzle source. Entirely opt-in — the app never depends on
// network access; callers should always have a local-generation fallback ready.

const SUGOKU_BASE = 'https://sugoku.onrender.com';

// Maps our Easy/Normal/Hard scale onto the API's easy/medium/hard scale.
const DIFFICULTY_MAP = {
  easy: 'easy',
  normal: 'medium',
  hard: 'hard',
};

/**
 * Fetches a puzzle board from the web. Throws on any failure (offline, timeout,
 * non-OK response, malformed payload) — callers should catch and fall back to
 * local generation.
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {number} timeoutMs
 * @returns {Promise<number[][]>} 9x9 board, 0 = blank cell
 */
export async function fetchPuzzleFromWeb(difficulty, timeoutMs = 6000) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Browser reports offline');
  }

  const level = DIFFICULTY_MAP[difficulty] || 'medium';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${SUGOKU_BASE}/board?difficulty=${level}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Request failed with status ${res.status}`);

    const data = await res.json();
    if (!data || !Array.isArray(data.board) || data.board.length !== 9) {
      throw new Error('Malformed response from puzzle source');
    }

    const board = data.board.map((row) => {
      if (!Array.isArray(row) || row.length !== 9) throw new Error('Malformed row');
      return row.map((v) => Number(v) || 0);
    });

    return board;
  } finally {
    clearTimeout(timer);
  }
}
