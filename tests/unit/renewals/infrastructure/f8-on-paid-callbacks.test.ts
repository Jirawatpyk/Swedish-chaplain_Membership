/**
 * Unit tests for `f8OnPaidCallbacks` dispatch logic — Round 4 review-fix R4-I2.
 *
 * The F4 → F8 onPaidCallback path is the single most-load-bearing piece
 * of cross-module wiring in F8: every paid renewal invoice fires
 * exactly one of the two cycle-complete entry points
 * (`markCycleCompleteInTx` for atomic single-tx mode,
 * `markCycleCompleteFromInvoicePaid` for the legacy two-tx fallback).
 * Round 3 R3-I8 added the `renewalsMetrics.onPaidInvalidTx` counter
 * specifically to detect F4 contract drift (a future refactor that
 * wraps `tx` in instrumentation, a polyfill that strips Drizzle's
 * method shape, etc.). Round 4 R4-S1 added the
 * `renewalsMetrics.onPaidUnknownOutcomeKind` counter for deploy-skew
 * (use-case ships a 5th outcome variant before this dispatch site
 * rebuilds). Both guard-rails were ZERO-tested at K20 ship — a
 * regression that re-opened the I3 atomic-tx invariant or silently
 * swallowed an unknown outcome would not have been caught by the
 * test suite.
 *
 * This file locks BOTH guard-rails:
 *   - InTx happy path: tx threaded with full Drizzle method shape →
 *     `markCycleCompleteInTx` invoked, no warning metric bumped.
 *   - Non-TenantTx fallback: tx threaded with missing methods →
 *     `onPaidInvalidTx` bumped + `logger.error` fired with errorId,
 *     `markCycleCompleteFromInvoicePaid` (wrapper) invoked instead.
 *   - Unknown outcome kind: stub returns kind='kill_switch_blocked'
 *     (a fictional 5th variant) → `onPaidUnknownOutcomeKind` bumped +
 *     `logger.error` fires with errorId.
 *
 * Lives in `tests/unit/renewals/infrastructure/` separately from
 * `renewals-deps.test.ts` because the metric/logger spies and use-case
 * stub are file-level `vi.mock`s that would interfere with the existing
 * composition-root tests in the sibling file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted to module top — references to ordinary
// `const fn = vi.fn()` declarations would be uninitialised at hoist
// time. `vi.hoisted` registers these alongside the mock factories so
// they're available when the mocks are wired up.
const {
  onPaidInvalidTxAdd,
  onPaidUnknownOutcomeKindAdd,
  loggerErrorMock,
  markCycleCompleteInTxMock,
  markCycleCompleteFromInvoicePaidMock,
} = vi.hoisted(() => ({
  onPaidInvalidTxAdd: vi.fn(),
  onPaidUnknownOutcomeKindAdd: vi.fn(),
  loggerErrorMock: vi.fn(),
  markCycleCompleteInTxMock: vi.fn(),
  markCycleCompleteFromInvoicePaidMock: vi.fn(),
}));

vi.mock('@/lib/metrics', async (importOriginal) => {
  // Preserve all other counters so unrelated module-load metric calls
  // (renewalsMetrics.bounceHookFailed, etc.) don't blow up during the
  // makeRenewalsDeps call that f8OnPaidCallbacks runs first.
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    renewalsMetrics: {
      ...actual.renewalsMetrics,
      onPaidInvalidTx: { add: onPaidInvalidTxAdd },
      onPaidUnknownOutcomeKind: { add: onPaidUnknownOutcomeKindAdd },
    },
  };
});

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    logger: {
      ...actual.logger,
      error: loggerErrorMock,
    },
  };
});

// Stub the cycle-complete use-case at the dynamic-import path. The
// f8OnPaidCallbacks dynamic-imports via `'../application/use-cases/...'`
// (relative) but the SAME module is reachable via the alias path —
// vi.mock at the alias level captures both.
vi.mock(
  '@/modules/renewals/application/use-cases/mark-cycle-complete-from-invoice-paid',
  () => ({
    markCycleCompleteInTx: markCycleCompleteInTxMock,
    markCycleCompleteFromInvoicePaid: markCycleCompleteFromInvoicePaidMock,
  }),
);

import { f8OnPaidCallbacks } from '@/modules/renewals/infrastructure/renewals-deps';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';

const buildEvent = (): F4InvoicePaidEvent => ({
  tenantId: 'test-tenant',
  invoiceId: '11111111-1111-1111-1111-111111111111',
  memberId: '22222222-2222-2222-2222-222222222222',
  paidAt: '2026-05-08T10:00:00Z',
  amountSatang: 5_000_000n,
  vatSatang: 350_000n,
  currency: 'THB',
  paymentMethod: 'stripe_card',
  triggeredBy: 'webhook',
});

// A fake tx handle that satisfies the `isTenantTx` 6-method duck-type
// check at `src/lib/db.ts`. The methods are no-ops because the use-case
// is mocked below — `markCycleCompleteInTx` never actually queries.
const fakeValidTenantTx = {
  execute: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};

describe('f8OnPaidCallbacks dispatch — R4-I2 + R4-S1 guard-rail tests', () => {
  beforeEach(() => {
    onPaidInvalidTxAdd.mockReset();
    onPaidUnknownOutcomeKindAdd.mockReset();
    loggerErrorMock.mockReset();
    markCycleCompleteInTxMock.mockReset();
    markCycleCompleteFromInvoicePaidMock.mockReset();
  });

  it('valid TenantTx threaded → InTx variant called, no metric bumped (I3 atomic-tx happy path)', async () => {
    markCycleCompleteInTxMock.mockResolvedValueOnce({
      kind: 'completed',
      cycleId: 'cyc-1',
      memberId: 'mem-1',
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    // Phase 7 T183 — callback array now has 2 entries: cycle-complete +
    // apply-pending-tier-upgrade. Index 0 is the cycle-complete
    // dispatcher this test exercises.
    expect(callbacks).toHaveLength(2);

    await callbacks[0]!(buildEvent(), fakeValidTenantTx);

    expect(markCycleCompleteInTxMock).toHaveBeenCalledTimes(1);
    expect(markCycleCompleteFromInvoicePaidMock).not.toHaveBeenCalled();
    expect(onPaidInvalidTxAdd).not.toHaveBeenCalled();
    expect(onPaidUnknownOutcomeKindAdd).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('R3-I8 lock: non-TenantTx → onPaidInvalidTx bumped + logger.error + wrapper variant invoked', async () => {
    // Object missing `select`/`insert`/etc. — simulates F4 contract
    // drift (refactor wrapped tx in instrumentation, polyfill stripped
    // Drizzle's method shape, etc.).
    const notATx = { execute: vi.fn() }; // 1/6 methods present
    markCycleCompleteFromInvoicePaidMock.mockResolvedValueOnce({
      kind: 'completed',
      cycleId: 'cyc-1',
      memberId: 'mem-1',
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[0]!(buildEvent(), notATx);

    // Counter alert is the primary signal — Vercel alert rules attach
    // here, not to log strings.
    expect(onPaidInvalidTxAdd).toHaveBeenCalledTimes(1);
    expect(onPaidInvalidTxAdd).toHaveBeenCalledWith(1, {
      tenant_id: 'test-tenant',
    });

    // Structured log carries the errorId so SRE can correlate.
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [payload, message] = loggerErrorMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      errorId: 'F8.ONPAID.INVALID_TX',
      tenantId: 'test-tenant',
      invoiceId: expect.any(String),
      memberId: expect.any(String),
    });
    expect(message).toContain('non-TenantTx');

    // Degraded mode: dispatch falls through to the wrapper (which
    // opens its own runInTenant, re-introducing the eventual-
    // consistency window). The InTx variant must NOT have been
    // called with the bogus tx.
    expect(markCycleCompleteInTxMock).not.toHaveBeenCalled();
    expect(markCycleCompleteFromInvoicePaidMock).toHaveBeenCalledTimes(1);
  });

  it('R4-S1 lock: unknown outcome kind → onPaidUnknownOutcomeKind bumped + logger.error fires (deploy-skew defence)', async () => {
    // Simulate a deploy-skew where the use-case has shipped a 5th
    // variant before this dispatch site rebuilds. Cast through unknown
    // because the type-system would otherwise (correctly) refuse a
    // non-union literal.
    markCycleCompleteInTxMock.mockResolvedValueOnce({
      kind: 'kill_switch_blocked',
    } as unknown as { kind: 'completed'; cycleId: string; memberId: string });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[0]!(buildEvent(), fakeValidTenantTx);

    // Compile-time `_exhaustive: never` would catch this in steady
    // state; the runtime metric + log are belt-and-braces for the
    // deploy-skew window.
    expect(onPaidUnknownOutcomeKindAdd).toHaveBeenCalledTimes(1);
    expect(onPaidUnknownOutcomeKindAdd).toHaveBeenCalledWith(1, {
      tenant_id: 'test-tenant',
    });
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    const [payload, message] = loggerErrorMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      errorId: 'F8.ONPAID.UNKNOWN_OUTCOME_KIND',
      tenantId: 'test-tenant',
      kind: 'kill_switch_blocked',
    });
    expect(message).toContain('deploy-skew');

    // The known-kind switch arms (completed/held_pending_admin/
    // no_cycle_for_invoice/cycle_not_payable) must NOT have been bumped.
    expect(onPaidInvalidTxAdd).not.toHaveBeenCalled();
  });
});
