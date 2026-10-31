/**
 * Spec 140 s1 review round 2 (code-review #9) — the deadline an erasure route
 * gives the broadcasts cascade's terminal-draft pass, derived from that
 * route's own `maxDuration` so the two routes (`POST /api/members/{id}/erase`,
 * `reconcile-erasures`) cannot drift apart.
 *
 * Review rounds 3–4 (code-review #2, #1) — the deadline is checked only BEFORE
 * a row, so the reserve must hold the worst case after it: the row in progress
 * (DELETE 10 s + GET 10 s, each `AbortSignal.timeout`-bounded, + its evidence
 * tx, ~1 s), then the DB work of the cascades after broadcasts (renewals,
 * invoicing, the F1 user erasure, the content scrub, events), `member_erased`
 * and the response: ~22 s of bounded calls plus DB work, so 60 s.
 *
 * NOT covered, a known pre-existing unbounded call: the directory cascade's
 * Vercel Blob `del` calls (up to 1 logo and 100 archives,
 * `public-logo-blob-adapter.ts`, `private-blob-adapter.ts`) carry no timeout;
 * a follow-up issue tracks it. Sub-processor propagation — the one step a
 * re-drive cannot repeat — runs BEFORE the broadcasts cascade
 * (erase-member.ts), so it never competes for the reserve (its own bound is
 * slice 2).
 */
export const ERASURE_CASCADE_RESERVE_MS = 60_000;

/**
 * Spec 140 s1 review round 4 (code-review #2) — how long before the cascade
 * deadline `reconcile-erasures` stops STARTING members: one whole row (a 10 s
 * DELETE, a 10 s GET and the evidence tx), so a member started at the cutoff
 * can still settle a row before its deadline instead of deferring them all.
 */
export const ERASURE_MEMBER_START_FLOOR_MS = 30_000;

export function erasureMemberStartCutoff(deadline: Date): Date {
  return new Date(deadline.getTime() - ERASURE_MEMBER_START_FLOOR_MS);
}

export function erasureCascadeDeadline(startedAtMs: number, maxDurationSeconds: number): Date {
  return new Date(startedAtMs + maxDurationSeconds * 1000 - ERASURE_CASCADE_RESERVE_MS);
}
