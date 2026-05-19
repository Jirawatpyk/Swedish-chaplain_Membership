/**
 * T025 — Levenshtein distance pure function (F6 Domain).
 *
 * Hand-rolled DP-table edit-distance — no library dependency per
 * Constitution Principle X (Simplicity) + research.md R4.
 *
 * Behavior:
 *   - Returns the minimum number of single-character edits (insert,
 *     delete, substitute) to transform `a` → `b`.
 *   - Symmetric: `levenshtein(a, b) === levenshtein(b, a)`.
 *   - Identity: `levenshtein(x, x) === 0`.
 *   - Bounds: `levenshtein(a, b) <= max(a.length, b.length)`.
 *
 * Performance: O(|a| * |b|) time + O(min(|a|, |b|)) space. At the F6
 * envelope (company-name strings ≤ 200 chars, ≤2,000 candidate members
 * per tenant), worst-case is 200 * 200 * 2000 = ~80M cell ops per
 * ingest — fast enough on Vercel Fluid Compute. perf bench in Phase 10
 * T139 asserts p95 < 50ms.
 *
 * Space-optimised: only two rows of the DP table are kept at a time.
 *
 * Pure TypeScript — Constitution Principle III. Deterministic. No
 * Unicode normalisation (assume caller has lower-cased + normalised via
 * `normaliseCompanyName` first).
 */

export function levenshtein(a: string, b: string): number {
  // Trivial cases — empty strings.
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a === b) return 0;

  // Optimise by iterating over the shorter axis so the two-row buffer
  // is min(|a|, |b|) + 1 cells.
  if (a.length < b.length) {
    [a, b] = [b, a];
  }

  // After swap: |a| >= |b|. We allocate a single (|b| + 1)-cell row
  // and re-use it. `prev[j]` holds DP[i-1][j]; `prev[j-1]` (before
  // overwrite) holds DP[i-1][j-1].
  const cols = b.length;
  const prev = new Array<number>(cols + 1);
  for (let j = 0; j <= cols; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!; // DP[i-1][0] = i-1
    prev[0] = i;
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j <= cols; j++) {
      const above = prev[j]!; // DP[i-1][j]
      const left = prev[j - 1]!; // DP[i][j-1] (already overwritten in this row)
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const next = Math.min(
        above + 1, // deletion
        left + 1, // insertion
        diag + cost, // substitution
      );
      diag = above;
      prev[j] = next;
    }
  }

  return prev[cols]!;
}
