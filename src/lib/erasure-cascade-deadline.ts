/**
 * Spec 140 s1 review round 2 (code-review #9) — the deadline an erasure route
 * gives the broadcasts cascade's terminal-draft pass, derived from that
 * route's own `maxDuration` so the two routes (`POST /api/members/{id}/erase`,
 * `reconcile-erasures`) cannot drift apart.
 *
 * Review round 3 (code-review #2) — the deadline is checked only BEFORE a row,
 * so the reserve must hold the worst case after it: the row in progress
 * (DELETE 10 s + GET 10 s, each `AbortSignal.timeout`-bounded, + its evidence
 * tx, ~1 s), then every cascade after broadcasts (renewals, invoicing, the F1
 * user erasure, the content scrub, events, directory — DB transactions, no
 * provider call), `member_erased` and the response: ~22 s of bounded calls plus
 * DB work, so 60 s. Sub-processor propagation — the one step a re-drive
 * cannot repeat — runs BEFORE the broadcasts cascade (erase-member.ts), so it
 * never competes for the reserve.
 */
export const ERASURE_CASCADE_RESERVE_MS = 60_000;

export function erasureCascadeDeadline(startedAtMs: number, maxDurationSeconds: number): Date {
  return new Date(startedAtMs + maxDurationSeconds * 1000 - ERASURE_CASCADE_RESERVE_MS);
}
