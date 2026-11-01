/**
 * Spec 140 s2b — the dispatch lease's constants and its time budget (DL9).
 *
 * The import tick CLAIMS a row (`BroadcastsRepo.claimDispatchLease`) for
 * `LEASE_TTL_MS`, re-checks it before every irreversible Resend call with
 * `CALL_HEADROOM_MS` (`IMPORT_HEADROOM_MS` before the import POST) of lease
 * left, and releases it at the end. The cron route starts no row after
 * `ROW_START_CUTOFF_MS` into its invocation, on either leg.
 *
 * Every literal below is pinned to its derivation by
 * `tests/unit/broadcasts/application/dispatch-lease-budget.test.ts`, which
 * computes both longest paths from `LEASE_BUDGET_INPUTS` (A5):
 *
 *   tick 1 = k·E + D + 5·C + I + P = 46 + 15 + 50 + 30 + 3 = 144 s
 *   tick 2 = k·E + N·C + P + D     = 46 + 90 + 3 + 15       = 154 s
 *   W_max  = max(tick 1, tick 2)                            = 154 s  (W_MAX_MS)
 *   cutoff = maxDuration − W_max − M = 300 − 154 − 15        = 131 s  (ROW_START_CUTOFF_MS)
 *   TTL    = 330 s > maxDuration 300 s, and ≥ W_max + M = 169 s (LEASE_TTL_MS)
 *
 * C = `RESEND_CALL_TIMEOUT_MS`, I = `IMPORT_CALL_TIMEOUT_MS` (both in the
 * gateway port, so infrastructure reads them from there), P =
 * `REPROBE_PAUSE_MS`. A dead holder's lease expires `LEASE_TTL_MS` after its
 * claim: the next tick (+300 s) skips the row, the one after (+600 s) takes
 * it over — about two ticks (`docs/runbooks/broadcast-audience-build.md`).
 *
 * Pure Application — no framework imports.
 */
import {
  IMPORT_CALL_TIMEOUT_MS,
  RESEND_CALL_TIMEOUT_MS,
} from '../ports/broadcasts-gateway-port';
import { REPROBE_PAUSE_MS } from './_reprobe-pause';

/** E — the longest an erasure cascade holds a broadcast's row lock: 10 s DELETE + 3 s pause + 10 s GET (D-040). */
export const ERASURE_ROW_LOCK_HOLD_MS = 23_000;

/** k — row-lock waits per row per tick: the claim, plus one pre-call check (one cascade per row per tick). ASSUMED. */
export const LOCK_WAITS_PER_ROW = 2;

/**
 * N — Resend calls on tick 2's longest path, counted from the code: probe,
 * re-probe, `getContactImport`, `getAudienceContactCount`, `createBroadcast`,
 * `sendBroadcast`, the refused-send probe, then a terminal reclaim's
 * `deleteBroadcastOnce` + `retrieveBroadcastOnce` (slice 2c's choke point,
 * counted now so 2c does not move the budget).
 */
export const TICK2_RESEND_CALLS = 9;

/** The calls at C on tick 1's longest path besides the import POST (probe, re-probe, the standing gate's delete, its GET, `createAudience`). */
export const TICK1_BOUNDED_CALLS = 5;

/**
 * D — DB statements plus one `resolveRecipients` for one row: ~15 short
 * statements and a resolve at the 900-recipient ceiling. **ASSUMED** — the
 * main session measures the p99 on the dev branch and replaces this label
 * (plan.md § Slice 2b, A10).
 */
export const DB_AND_RESOLVE_MS = 15_000;

/** M — the margin a pre-call check demands beyond the call's own timeout: ≥ C, + 5 s for the post-call CAS. */
export const LEASE_MARGIN_MS = 15_000;

/** The lease a pre-call check demands left before an ordinary Resend call: C + M. */
export const CALL_HEADROOM_MS = RESEND_CALL_TIMEOUT_MS + LEASE_MARGIN_MS;

/** The lease a pre-call check demands left before `createContactImport`: I + M. */
export const IMPORT_HEADROOM_MS = IMPORT_CALL_TIMEOUT_MS + LEASE_MARGIN_MS;

/** The dispatch cron route's `maxDuration` (300 s), in ms — pinned to the route's literal by the budget test. */
export const DISPATCH_MAX_DURATION_MS = 300_000;

/** W_max — the longer of the two longest paths (tick 2, 154 s). */
export const W_MAX_MS = 154_000;

/** How long a claim holds: > `DISPATCH_MAX_DURATION_MS` and ≥ `W_MAX_MS` + `LEASE_MARGIN_MS`. */
export const LEASE_TTL_MS = 330_000;

/** No row starts later than this into a tick: `DISPATCH_MAX_DURATION_MS` − `W_MAX_MS` − `LEASE_MARGIN_MS`. */
export const ROW_START_CUTOFF_MS = 131_000;

/** The terms of the budget, in one object so the test can vary one at a time. */
export interface LeaseBudgetInputs {
  readonly callTimeoutMs: number;
  readonly importCallTimeoutMs: number;
  readonly reprobePauseMs: number;
  readonly erasureRowLockHoldMs: number;
  readonly lockWaitsPerRow: number;
  readonly tick1BoundedCalls: number;
  readonly tick2ResendCalls: number;
  readonly dbAndResolveMs: number;
  readonly marginMs: number;
}

export const LEASE_BUDGET_INPUTS: LeaseBudgetInputs = {
  callTimeoutMs: RESEND_CALL_TIMEOUT_MS,
  importCallTimeoutMs: IMPORT_CALL_TIMEOUT_MS,
  reprobePauseMs: REPROBE_PAUSE_MS,
  erasureRowLockHoldMs: ERASURE_ROW_LOCK_HOLD_MS,
  lockWaitsPerRow: LOCK_WAITS_PER_ROW,
  tick1BoundedCalls: TICK1_BOUNDED_CALLS,
  tick2ResendCalls: TICK2_RESEND_CALLS,
  dbAndResolveMs: DB_AND_RESOLVE_MS,
  marginMs: LEASE_MARGIN_MS,
};

/** Both longest paths, from the inputs (A5). */
export function longestPathsMs(i: LeaseBudgetInputs): { readonly tick1: number; readonly tick2: number } {
  const lockWaits = i.lockWaitsPerRow * i.erasureRowLockHoldMs;
  return {
    tick1: lockWaits + i.dbAndResolveMs + i.tick1BoundedCalls * i.callTimeoutMs + i.importCallTimeoutMs + i.reprobePauseMs,
    tick2: lockWaits + i.tick2ResendCalls * i.callTimeoutMs + i.reprobePauseMs + i.dbAndResolveMs,
  };
}

/**
 * The inequalities the lease rests on, by name; `[]` = all hold. Also checks
 * that the shipped literals (`W_MAX_MS`, `ROW_START_CUTOFF_MS`) still equal
 * what the inputs derive, so a changed input cannot leave a stale literal.
 */
export function leaseBudgetViolations(i: LeaseBudgetInputs, ttlMs: number, maxDurationMs: number): string[] {
  const { tick1, tick2 } = longestPathsMs(i);
  const wMax = Math.max(tick1, tick2);
  const cutoff = maxDurationMs - wMax - i.marginMs;
  const beforeImportPost = i.lockWaitsPerRow * i.erasureRowLockHoldMs + i.dbAndResolveMs + i.tick1BoundedCalls * i.callTimeoutMs + i.reprobePauseMs;
  const out: string[] = [];
  if (!(ttlMs > maxDurationMs)) out.push('TTL > maxDuration');
  if (!(ttlMs >= wMax + i.marginMs)) out.push('TTL ≥ W_max + M');
  if (!(cutoff > 0)) out.push('cutoff > 0');
  if (!(i.callTimeoutMs <= i.marginMs)) out.push('C ≤ M');
  if (!(beforeImportPost + i.importCallTimeoutMs + i.marginMs <= ttlMs)) out.push('before-import + I + M ≤ TTL');
  if (wMax !== W_MAX_MS) out.push('W_max matches the literal');
  if (cutoff !== ROW_START_CUTOFF_MS) out.push('cutoff matches the literal');
  return out;
}

/**
 * When the cron invocation began and how long it may run (its route's
 * `maxDuration`). Passed into both legs' deps by the dispatch route (DL9).
 */
export interface TickBudget {
  readonly tickStartedAt: number;
  readonly maxDurationMs: number;
}

/**
 * DL9 — may a row START at `nowMs`? Only up to `maxDurationMs − W_MAX_MS −
 * LEASE_MARGIN_MS` into the invocation; a later row stays `approved`,
 * unleased, for the next tick.
 */
export function rowStartAllowed(budget: TickBudget, nowMs: number): boolean {
  return nowMs - budget.tickStartedAt <= budget.maxDurationMs - W_MAX_MS - LEASE_MARGIN_MS;
}
