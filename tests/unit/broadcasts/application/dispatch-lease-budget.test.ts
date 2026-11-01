/**
 * Spec 140 s2b (DL9, A5) — the dispatch lease's time budget, derived from the
 * exported constants rather than restated.
 *
 * Two longest paths, one per tick of the import leg:
 *   tick 1 = k·L + D + 5·C + I + P   (the import POST at IMPORT_CALL_TIMEOUT_MS; L = CHECK_LOCK_TIMEOUT_MS)
 *   tick 2 = k·L + N·C + P + D       (N Resend calls at RESEND_CALL_TIMEOUT_MS)
 * W_max is the larger. The inequalities the lease rests on:
 *   - TTL > maxDuration          (a holder killed at maxDuration never outlives its lease)
 *   - TTL ≥ W_max + M            (a row started at the cutoff finishes inside its lease)
 *   - cutoff = maxDuration − W_max − M > 0
 *   - C ≤ M                      (a call's timeout fits inside the pre-call margin)
 *   - (time before the import POST) + I + M ≤ TTL
 * Positive controls: the checker must REFUSE a 300 s TTL, and an import budget
 * that makes tick 1 the longer path must change W_max — so a green run here is
 * not a checker that accepts anything.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CALL_HEADROOM_MS,
  CHECK_LOCK_TIMEOUT_MS,
  ERASURE_ROW_LOCK_HOLD_MS,
  DISPATCH_MAX_DURATION_MS,
  IMPORT_HEADROOM_MS,
  LEASE_BUDGET_INPUTS,
  LEASE_MARGIN_MS,
  LEASE_TTL_MS,
  ROW_START_CUTOFF_MS,
  W_MAX_MS,
  leaseBudgetViolations,
  longestPathsMs,
  rowStartAllowed,
} from '@/modules/broadcasts/application/use-cases/_dispatch-lease';
import {
  IMPORT_CALL_TIMEOUT_MS,
  RESEND_CALL_TIMEOUT_MS,
} from '@/modules/broadcasts/application/ports/broadcasts-gateway-port';
import { REPROBE_PAUSE_MS } from '@/modules/broadcasts/application/use-cases/_reprobe-pause';

const ROUTE = 'src/app/api/cron/broadcasts/dispatch-scheduled/route.ts';

describe('spec 140 s2b — the dispatch lease budget (DL9, A5)', () => {
  it('the inputs are the exported constants they name (C, I, P from their homes)', () => {
    expect(LEASE_BUDGET_INPUTS.checkLockTimeoutMs).toBe(CHECK_LOCK_TIMEOUT_MS);
    expect(LEASE_BUDGET_INPUTS.callTimeoutMs).toBe(RESEND_CALL_TIMEOUT_MS);
    expect(LEASE_BUDGET_INPUTS.importCallTimeoutMs).toBe(IMPORT_CALL_TIMEOUT_MS);
    expect(LEASE_BUDGET_INPUTS.reprobePauseMs).toBe(REPROBE_PAUSE_MS);
    expect(LEASE_BUDGET_INPUTS.marginMs).toBe(LEASE_MARGIN_MS);
  });

  it('the route declares the maxDuration the budget is computed for', () => {
    const m = /export const maxDuration = (\d+);\r?\n/.exec(readFileSync(ROUTE, 'utf8'));
    expect(m, 'no `export const maxDuration = <n>;` in the dispatch route').not.toBeNull();
    expect(Number(m![1]) * 1000).toBe(DISPATCH_MAX_DURATION_MS);
  });

  it('review round 2 — lock waits are charged at CHECK_LOCK_TIMEOUT_MS: tick 1 = k·L + D + 5·C + I + P and tick 2 = k·L + N·C + P + D; W_max is the larger (tick 2 today)', () => {
    const i = LEASE_BUDGET_INPUTS;
    const { tick1, tick2 } = longestPathsMs(i);
    expect(tick1).toBe(i.lockWaitsPerRow * i.checkLockTimeoutMs + i.dbAndResolveMs + i.tick1BoundedCalls * i.callTimeoutMs + i.importCallTimeoutMs + i.reprobePauseMs);
    expect(tick2).toBe(i.lockWaitsPerRow * i.checkLockTimeoutMs + i.tick2ResendCalls * i.callTimeoutMs + i.reprobePauseMs + i.dbAndResolveMs);
    expect(tick1).toBe(154_000);
    expect(tick2).toBe(164_000);
    expect(W_MAX_MS).toBe(Math.max(tick1, tick2));
  });

  it('the literal constants equal their derivation: cutoff = maxDuration − W_max − M, headroom = C + M and I + M', () => {
    expect(ROW_START_CUTOFF_MS).toBe(DISPATCH_MAX_DURATION_MS - W_MAX_MS - LEASE_MARGIN_MS);
    expect(ROW_START_CUTOFF_MS).toBe(121_000);
    expect(CALL_HEADROOM_MS).toBe(RESEND_CALL_TIMEOUT_MS + LEASE_MARGIN_MS);
    expect(IMPORT_HEADROOM_MS).toBe(IMPORT_CALL_TIMEOUT_MS + LEASE_MARGIN_MS);
  });

  it('review round 1 (reliability L2) — the pre-call check waits at most E + 5 s for the row lock', () => {
    expect(CHECK_LOCK_TIMEOUT_MS).toBe(ERASURE_ROW_LOCK_HOLD_MS + 5_000);
    expect(CHECK_LOCK_TIMEOUT_MS).toBe(28_000);
  });

  it('every inequality holds for the shipped values', () => {
    expect(leaseBudgetViolations(LEASE_BUDGET_INPUTS, LEASE_TTL_MS, DISPATCH_MAX_DURATION_MS)).toEqual([]);
  });

  it('positive control — a 300 s TTL (= maxDuration) is refused', () => {
    expect(leaseBudgetViolations(LEASE_BUDGET_INPUTS, 300_000, DISPATCH_MAX_DURATION_MS)).toContain('TTL > maxDuration');
  });

  it('positive control — an import budget that makes tick 1 the longest path changes W_max, and the shipped W_max no longer covers it', () => {
    const slow = { ...LEASE_BUDGET_INPUTS, importCallTimeoutMs: 60_000 };
    const { tick1, tick2 } = longestPathsMs(slow);
    expect(tick1).toBeGreaterThan(tick2);
    expect(Math.max(tick1, tick2)).not.toBe(W_MAX_MS);
    expect(leaseBudgetViolations(slow, LEASE_TTL_MS, DISPATCH_MAX_DURATION_MS)).toContain('W_max matches the literal');
  });

  it('positive control — a margin shorter than the call timeout is refused (C ≤ M)', () => {
    expect(leaseBudgetViolations({ ...LEASE_BUDGET_INPUTS, marginMs: 5_000 }, LEASE_TTL_MS, DISPATCH_MAX_DURATION_MS)).toContain('C ≤ M');
  });

  it('rowStartAllowed: a row may start up to the cutoff after the tick began, not after', () => {
    const budget = { tickStartedAt: 1_000_000, maxDurationMs: DISPATCH_MAX_DURATION_MS };
    expect(rowStartAllowed(budget, 1_000_000)).toBe(true);
    expect(rowStartAllowed(budget, 1_000_000 + ROW_START_CUTOFF_MS)).toBe(true);
    expect(rowStartAllowed(budget, 1_000_000 + ROW_START_CUTOFF_MS + 1)).toBe(false);
  });
});
