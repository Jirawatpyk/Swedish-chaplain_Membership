/**
 * Part-to-whole percentages for dashboard cards — the home dashboard's
 * invoice-status card and the invoice dashboard's aging card (spec 124 US1.3).
 * Pure, no framework imports, client-safe.
 */

/** Largest-remainder ("Hare quota") allocation — NOT independent
 * `Math.round(n / total * 100)` per bucket. Three shares rounded
 * independently can land on e.g. 33/33/33 (sum 99) or 34/34/34 (sum 101)
 * for a total that isn't a clean multiple of the bucket count, which then
 * contradicts the hard-coded "100%" Total row. This guarantees the returned
 * integers always sum to exactly 100 whenever `total > 0`: floor every raw
 * share, then hand the leftover percentage points (an integer, since it's
 * 100 minus a sum of integers) one-by-one to the buckets with the largest
 * fractional remainder, tie-broken by original index for determinism. */
export function allocatePercentages(values: readonly number[]): number[] {
  // A negative (or non-finite) slice has no part-to-whole reading: refuse the
  // whole allocation — mixed signs can still sum positive ([-100, 500] → 125%).
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return values.map(() => 0);
  }
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);

  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  const leftover = 100 - floors.reduce((sum, f) => sum + f, 0);

  const byRemainderDesc = raw
    .map((r, index) => ({ index, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const result = [...floors];
  for (const { index } of byRemainderDesc.slice(0, leftover)) {
    result[index] = (result[index] ?? 0) + 1;
  }
  return result;
}

/**
 * {@link allocatePercentages} as display labels. A real amount that rounds to
 * 0% reads `<1%`, never a bare `0%` beside a non-zero amount (financial
 * review, 17 Oct). When the allocation refused its input (a negative value)
 * and returned all zeros, `0%` is the honest reading, never `<1%`.
 */
export function formatSharePercentages(values: readonly number[]): string[] {
  const shares = allocatePercentages(values);
  const allocated = shares.some((p) => p > 0);
  return shares.map((pct, i) =>
    allocated && pct === 0 && (values[i] ?? 0) > 0 ? '<1%' : `${pct}%`,
  );
}
