/**
 * Token-level LCS / Dice coefficient for PDF text similarity.
 * Same metric as TeXFix-Bench: S_pdf = 2 * LCS(P(a), P(b)) / (|P(a)| + |P(b)|)
 * where P = lowercase whitespace-token sequence from pdftotext.
 *
 * License: MIT
 */

/** Max tokens per side for full LCS (O(n*m) time). Longer texts are truncated. */
export const LCS_TOKEN_CAP = 15_000;

/**
 * Normalize PDF text into lowercase whitespace tokens.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizePdfText(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Length of longest common subsequence of two token arrays.
 * Uses O(min(n,m)) extra space rolling arrays of Uint32.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function lcsLength(a, b) {
  if (!a.length || !b.length) return 0;
  // Ensure b is the shorter (or equal) for memory locality of inner loop over j.
  if (a.length < b.length) {
    const t = a;
    a = b;
    b = t;
  }
  const n = b.length;
  const prev = new Uint32Array(n + 1);
  const curr = new Uint32Array(n + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      curr[j] =
        ai === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
  }
  return prev[n];
}

/**
 * Dice coefficient on token LCS: 2 * LCS / (|a| + |b|).
 * Empty-vs-empty is 1.0; empty-vs-nonempty is 0.0.
 * @param {string} textA
 * @param {string} textB
 * @param {{ cap?: number }} [opts]
 * @returns {{ score: number, tokensA: number, tokensB: number, lcs: number, truncated: boolean }}
 */
export function pdfTextSimilarity(textA, textB, opts = {}) {
  const cap = opts.cap ?? LCS_TOKEN_CAP;
  let a = tokenizePdfText(textA);
  let b = tokenizePdfText(textB);
  const tokensA = a.length;
  const tokensB = b.length;
  if (tokensA === 0 && tokensB === 0) {
    return { score: 1.0, tokensA: 0, tokensB: 0, lcs: 0, truncated: false };
  }
  if (tokensA === 0 || tokensB === 0) {
    return { score: 0.0, tokensA, tokensB, lcs: 0, truncated: false };
  }
  let truncated = false;
  if (a.length > cap) {
    a = a.slice(0, cap);
    truncated = true;
  }
  if (b.length > cap) {
    b = b.slice(0, cap);
    truncated = true;
  }
  const lcs = lcsLength(a, b);
  const score = (2 * lcs) / (a.length + b.length);
  return { score, tokensA, tokensB, lcs, truncated };
}

/**
 * Build a 4x4 similarity matrix for engines in the given order.
 * Diagonal is 1.0. Missing texts yield null cells.
 *
 * @param {Record<string, string|null|undefined>} textsByEngine
 * @param {string[]} engines
 * @param {{ threshold?: number, cap?: number }} [opts]
 */
export function buildSimilarityMatrix(textsByEngine, engines, opts = {}) {
  const threshold = opts.threshold ?? 0.95;
  const n = engines.length;
  /** @type {(number|null)[][]} */
  const matrix = Array.from({ length: n }, () => Array(n).fill(null));
  /** @type {Record<string, number>} */
  const pairwise = {};
  let minOffDiag = 1.0;
  let anyPair = false;
  let anyTruncated = false;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1.0;
        continue;
      }
      const ta = textsByEngine[engines[i]];
      const tb = textsByEngine[engines[j]];
      if (ta == null || tb == null) {
        matrix[i][j] = null;
        continue;
      }
      const r = pdfTextSimilarity(ta, tb, { cap: opts.cap });
      matrix[i][j] = r.score;
      if (r.truncated) anyTruncated = true;
      if (i < j) {
        pairwise[`${engines[i]}__${engines[j]}`] = r.score;
        anyPair = true;
        if (r.score < minOffDiag) minOffDiag = r.score;
      }
    }
  }

  const flagged_inconsistent = anyPair && minOffDiag < threshold;
  return {
    engines: [...engines],
    similarity_matrix: matrix,
    pairwise,
    min_pairwise: anyPair ? minOffDiag : null,
    flagged_inconsistent,
    truncated: anyTruncated,
    threshold,
  };
}
