/**
 * F9 (067-dashboard-interactive-charts) — shared `prefers-reduced-motion`
 * subscription for every Recharts chart in this feature. Extracted (Task 10)
 * from `_mini-series-chart.tsx` (the first chart to need it, Task 9) so a
 * second chart (`membership-tier-chart.tsx`) doesn't duplicate the same
 * `useSyncExternalStore` triad — any future chart imports this instead of
 * re-declaring its own copy.
 *
 * Usage (identical in every caller):
 * ```ts
 * const allowMotion = useSyncExternalStore(
 *   subscribeMotionPreference,
 *   getAllowMotion,
 *   getServerAllowMotion,
 * );
 * ```
 *
 * SSR-safe default: `getServerAllowMotion` always returns `false` — used for
 * both the real server render AND the client's hydration-matching first
 * render, so there is no hydration mismatch — then flips to the live
 * `matchMedia` result once the browser confirms
 * `prefers-reduced-motion: no-preference` post-mount. Same idiom already
 * shipped in `src/components/plans/plan-list-skeleton.tsx`.
 */

export function subscribeMotionPreference(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', callback);
  return () => mq.removeEventListener('change', callback);
}

export function getAllowMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** SSR-safe default: no animation until the browser confirms motion is OK,
 * post-mount — avoids a hydration mismatch. */
export function getServerAllowMotion(): boolean {
  return false;
}
