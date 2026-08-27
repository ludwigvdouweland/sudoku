// estimate.js
//
// There is no shared backend, so a real "vs other players worldwide" comparison
// isn't available (see storage.js). As a stand-in, this module approximates a
// percentile ranking using a MODELED distribution of typical human Sudoku
// solving times per difficulty — not real collected data from other users.
//
// Solve times for a fixed-difficulty task are well-approximated by a
// log-normal distribution (many people cluster around a typical time, with a
// long tail of much slower completions). Each difficulty is parameterized by
// a rough median solve time and a spread (sigma), set from commonly reported
// casual-solver benchmarks. These are estimates for illustrative comparison
// only, and the UI must always label them as modeled, not measured.

const DIFFICULTY_MODEL = {
  easy: { medianMs: 5 * 60 * 1000, sigma: 0.5 },
  normal: { medianMs: 12 * 60 * 1000, sigma: 0.5 },
  hard: { medianMs: 25 * 60 * 1000, sigma: 0.55 },
};

// Abramowitz & Stegun approximation of the error function (max error ~1.5e-7).
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function logNormalCdf(x, medianMs, sigma) {
  if (x <= 0) return 0;
  const mu = Math.log(medianMs);
  const z = (Math.log(x) - mu) / (sigma * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

/**
 * Estimated percentile ranking for a solve time against the modeled
 * distribution for that difficulty.
 * @param {'easy'|'normal'|'hard'} difficulty
 * @param {number} elapsedMs
 * @returns {{ outperformedPct: number, medianMs: number }}
 */
export function estimatePerformance(difficulty, elapsedMs) {
  const model = DIFFICULTY_MODEL[difficulty] || DIFFICULTY_MODEL.normal;
  const cdf = logNormalCdf(elapsedMs, model.medianMs, model.sigma); // fraction modeled as finishing at or before this time
  const outperformedPct = Math.round((1 - cdf) * 100); // fraction modeled as slower than the user
  return { outperformedPct: Math.min(99, Math.max(1, outperformedPct)), medianMs: model.medianMs };
}
