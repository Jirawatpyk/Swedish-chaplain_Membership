/**
 * Spec 140 s1 review round 2 (code-review #9) — the deadline an erasure route
 * gives the broadcasts cascade's terminal-draft pass, derived from that
 * route's own `maxDuration` so the two routes (`POST /api/members/{id}/erase`,
 * `reconcile-erasures`) cannot drift apart.
 *
 * The reserve covers the row in progress when the deadline passes (two bounded
 * 10 s Resend calls) and the cascades that run after broadcasts. Sub-processor
 * propagation — the one step a re-drive cannot repeat — runs BEFORE the
 * broadcasts cascade (erase-member.ts), so it is never left only the reserve.
 */
export const ERASURE_CASCADE_RESERVE_MS = 30_000;

export function erasureCascadeDeadline(startedAtMs: number, maxDurationSeconds: number): Date {
  return new Date(startedAtMs + maxDurationSeconds * 1000 - ERASURE_CASCADE_RESERVE_MS);
}
