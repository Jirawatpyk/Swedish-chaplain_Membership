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
import { asSatang } from '@/lib/money';

// vi.mock factories are hoisted to module top — references to ordinary
// `const fn = vi.fn()` declarations would be uninitialised at hoist
// time. `vi.hoisted` registers these alongside the mock factories so
// they're available when the mocks are wired up.
const {
  onPaidInvalidTxAdd,
  onPaidUnknownOutcomeKindAdd,
  loggerErrorMock,
  loggerFatalMock,
  markCycleCompleteInTxMock,
  markCycleCompleteFromInvoicePaidMock,
  applyPendingTierUpgradeInTxMock,
  tierUpgradeApplyPostPaidFailedMock,
  applyPendingInvalidTxAdd,
  auditEmitterEmitMock,
  // R2 Batch 3b (R2-I8) — F2 finaliser invocation assertions need
  // access to the F2 stub's `findPendingForCycle` + `transitionStatus`
  // + audit `record` spies so per-test mockResolvedValueOnce can drive
  // pending-row scenarios.
  f2FindPendingForCycleMock,
  f2TransitionStatusMock,
  f2AuditRecordMock,
  f2FinaliseBeforeF4CommitMock,
  // 065 Fix A precision — the F2 finaliser gate now keys on the PENDING F2
  // row's OWN linked suggestion status, resolved via
  // `tierUpgradeRepo.findById(reason → suggestionId)`. Spy so each test
  // drives superseded vs applied vs not-found.
  tierUpgradeFindByIdMock,
} = vi.hoisted(() => ({
  onPaidInvalidTxAdd: vi.fn(),
  onPaidUnknownOutcomeKindAdd: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerFatalMock: vi.fn(),
  markCycleCompleteInTxMock: vi.fn(),
  markCycleCompleteFromInvoicePaidMock: vi.fn(),
  applyPendingTierUpgradeInTxMock: vi.fn(),
  tierUpgradeApplyPostPaidFailedMock: vi.fn(),
  applyPendingInvalidTxAdd: vi.fn(),
  auditEmitterEmitMock: vi.fn(),
  f2FindPendingForCycleMock: vi.fn(),
  f2TransitionStatusMock: vi.fn(),
  f2AuditRecordMock: vi.fn(),
  f2FinaliseBeforeF4CommitMock: vi.fn(),
  tierUpgradeFindByIdMock: vi.fn(),
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
      tierUpgradeApplyPostPaidFailed: tierUpgradeApplyPostPaidFailedMock,
      applyPendingInvalidTx: { add: applyPendingInvalidTxAdd },
      // R2 Batch 3a (R2-C1) — operational counter for F2 finaliser
      // invocations. R2-I8 asserts this fires exactly once per
      // post-tx finaliser call.
      f2FinaliseBeforeF4Commit: f2FinaliseBeforeF4CommitMock,
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
      fatal: loggerFatalMock,
    },
  };
});

// Round 4 IMP-6 — stub the apply-pending-tier-upgrade use-case so we
// can drive the post-paid audit-emit failure path without a live DB.
vi.mock(
  '@/modules/renewals/application/use-cases/apply-pending-tier-upgrade',
  () => ({
    applyPendingTierUpgradeInTx: applyPendingTierUpgradeInTxMock,
  }),
);

// Round 4 IMP-6 — stub the cycle repo + audit emitter at the
// composition-root seam so f8OnPaidCallbacks composes a deps tree
// where `cyclesRepo.findByInvoiceIdInTx` returns a controllable
// cycle and `auditEmitter.emit` is observable.
const cyclesRepoFindByInvoiceIdInTxMock = vi.fn();
const cyclesRepoFindByIdInTxMock = vi.fn();
vi.mock(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-cycle-repo',
  () => ({
    makeDrizzleRenewalCycleRepo: () => ({
      findByInvoiceIdInTx: cyclesRepoFindByInvoiceIdInTxMock,
      findByIdInTx: cyclesRepoFindByIdInTxMock,
    }),
  }),
);

vi.mock(
  '@/modules/renewals/infrastructure/drizzle/drizzle-renewal-audit-emitter',
  () => ({
    makeDrizzleRenewalAuditEmitter: () => ({
      emit: auditEmitterEmitMock,
      emitInTx: vi.fn(async () => undefined),
    }),
  }),
);

// 065 Fix A precision — stub the F8 tier-upgrade suggestion repo factory so
// the finaliser's per-pending-row gate query (`findById(reason →
// suggestionId)`) is observable + does NOT hit live DB. The apply use-case
// is mocked separately, so only `findById` matters here. Default: the
// linked suggestion resolves `applied` (the normal accepted-then-paid
// case) — per-test overrides drive superseded / not-found.
vi.mock(
  '@/modules/renewals/infrastructure/drizzle/drizzle-tier-upgrade-suggestion-repo',
  () => ({
    makeDrizzleTierUpgradeSuggestionRepo: () => ({
      findById: tierUpgradeFindByIdMock,
    }),
  }),
);

// Post-ship R6 Batch 2d — F8 onPaid callback now wires a POST-tx F2
// finalisation step (flips `scheduled_plan_changes` pending → applied
// and emits `plan_change_applied`). Stub the F2 server sub-barrel so
// `makeRenewalsDeps` composes without touching live DB. The default
// stub makes the F2 finaliser a no-op (findPendingForCycle returns
// null = same-tier renewal, the common case + the test scenario here
// since the existing assertions don't care about F2 state).
// R2 Batch 3b (R2-I8) — F2 spies via hoisted refs so per-test
// `mockResolvedValueOnce` drives pending-row vs no-row scenarios.
// Defaults: findPendingForCycle returns null (same-tier renewal),
// audit record returns ok. transitionStatus is a no-op spy (callers
// only invoke it when findPendingForCycle returned a pending row).
vi.mock('@/modules/plans/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/plans/server')>();
  return {
    ...actual,
    drizzleScheduledPlanChangeRepo: {
      supersedeAndInsertPendingAtomically: vi.fn(),
      findPendingForCycle: f2FindPendingForCycleMock,
      findById: vi.fn(async () => null),
      transitionStatus: f2TransitionStatusMock,
      listForMember: vi.fn(),
    },
    planAuditAdapter: {
      record: f2AuditRecordMock,
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

// Round 4 IMP-6 — mock `@/lib/db.runInTenant` so the callback[1]
// fallback (invalid tx) path runs in a controlled tx-stub, AND
// makeRenewalsDeps's outer cyclesRepo lookup is short-circuitable.
// Also patches `auditEmitter.emit` via the renewals-deps composition
// so we can drive the post-paid audit-emit failure branch.
const fakeFallbackTx = {
  execute: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};

vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    runInTenant: vi.fn(
      async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
        fn(fakeFallbackTx),
    ),
    isTenantTx: actual.isTenantTx,
  };
});

import { f8OnPaidCallbacks } from '@/modules/renewals/infrastructure/renewals-deps';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';

const buildEvent = (): F4InvoicePaidEvent => ({
  tenantId: 'test-tenant',
  invoiceId: '11111111-1111-1111-1111-111111111111',
  memberId: '22222222-2222-2222-2222-222222222222',
  paidAt: '2026-05-08T10:00:00Z',
  amountSatang: asSatang(5_000_000n),
  vatSatang: asSatang(350_000n),
  currency: 'THB',
  paymentMethod: 'stripe_card',
  triggeredBy: 'webhook',
});

// 065 Fix A precision — the pending F2 row's `reason` carries
// `tier_upgrade_accepted:<UUID>`; the finaliser parses it back to the
// suggestion id and resolves THAT suggestion's status via
// `tierUpgradeRepo.findById`. The suffix MUST be a valid UUID (the
// `parseSuggestionIdFromReason` Domain helper rejects non-UUID suffixes →
// null → treated as a standalone schedule). These constants give the
// pending-row fixtures real linkable ids.
const LINKED_SUGGESTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STRAND_SUGGESTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
    loggerFatalMock.mockReset();
    markCycleCompleteInTxMock.mockReset();
    markCycleCompleteFromInvoicePaidMock.mockReset();
    applyPendingTierUpgradeInTxMock.mockReset();
    tierUpgradeApplyPostPaidFailedMock.mockReset();
    applyPendingInvalidTxAdd.mockReset();
    auditEmitterEmitMock.mockReset();
    cyclesRepoFindByInvoiceIdInTxMock.mockReset();
    cyclesRepoFindByIdInTxMock.mockReset();
    // R2 Batch 3b — F2 stub default: no pending row (common-case
    // same-tier renewal), audit record returns ok, finaliser counter
    // not bumped by default until per-test setup overrides.
    f2FindPendingForCycleMock.mockReset();
    f2FindPendingForCycleMock.mockResolvedValue(null);
    f2TransitionStatusMock.mockReset();
    f2AuditRecordMock.mockReset();
    f2AuditRecordMock.mockResolvedValue({ ok: true, value: undefined });
    f2FinaliseBeforeF4CommitMock.mockReset();
    // 065 Fix A precision — default: the pending row's linked suggestion
    // resolves `applied` (the normal accepted-then-paid case), so the
    // per-row gate is OPEN (it then no-ops if no pending row). Per-test
    // overrides drive `superseded` (skip) / not-found.
    tierUpgradeFindByIdMock.mockReset();
    tierUpgradeFindByIdMock.mockResolvedValue({ status: 'applied' });
  });

  it('valid TenantTx threaded → InTx variant called, no metric bumped (I3 atomic-tx happy path)', async () => {
    markCycleCompleteInTxMock.mockResolvedValueOnce({
      kind: 'completed',
      cycleId: 'cyc-1',
      memberId: 'mem-1',
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    // Phase 7 T183 + F8-completion slice 1 (Task 1.4) — callback array
    // now has 3 entries: [0] cycle-complete, [1] apply-pending-tier-
    // upgrade, [2] create-next-cycle-on-paid. Index 0 is the cycle-
    // complete dispatcher this test exercises.
    expect(callbacks).toHaveLength(3);

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

  // ─────────────────────────────────────────────────────────────────
  // Callback[1] — apply-pending-tier-upgrade dispatcher (R4-IMP-6)
  // ─────────────────────────────────────────────────────────────────

  it('R4-IMP-6 happy path: callback[1] valid tx + non-renewal cycle (null) — no-op', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValueOnce(null);
    const callbacks = f8OnPaidCallbacks('test-tenant');
    expect(callbacks).toHaveLength(3);

    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    expect(cyclesRepoFindByInvoiceIdInTxMock).toHaveBeenCalledTimes(1);
    expect(applyPendingTierUpgradeInTxMock).not.toHaveBeenCalled();
    expect(tierUpgradeApplyPostPaidFailedMock).not.toHaveBeenCalled();
  });

  it('R4-IMP-6 valid-tx apply-throw: logger.error + NO post-paid audit (non-fallback)', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValueOnce({
      cycleId: 'cyc-1',
      memberId: 'mem-1',
    });
    applyPendingTierUpgradeInTxMock.mockRejectedValueOnce(
      new Error('synthetic_apply_throw'),
    );

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await expect(
      callbacks[1]!(buildEvent(), fakeValidTenantTx),
    ).rejects.toThrow(/synthetic_apply_throw/);

    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    // Non-fallback path: F4 tx will roll back; the post-paid audit
    // is only emitted in the fallback branch.
    expect(tierUpgradeApplyPostPaidFailedMock).not.toHaveBeenCalled();
    expect(auditEmitterEmitMock).not.toHaveBeenCalled();
    expect(loggerFatalMock).not.toHaveBeenCalled();
  });

  it('R4-IMP-6 fallback apply-throw: counter + audit emit + NO logger.fatal (audit succeeds)', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValueOnce({
      cycleId: 'cyc-1',
      memberId: 'mem-1',
    });
    applyPendingTierUpgradeInTxMock.mockRejectedValueOnce(
      new Error('synthetic_apply_throw_in_fallback'),
    );
    auditEmitterEmitMock.mockResolvedValueOnce(undefined);

    const callbacks = f8OnPaidCallbacks('test-tenant');
    // Pass an invalid tx (missing methods) to force the fallback path.
    const invalidTx = { execute: vi.fn() }; // 1/6 methods present
    await expect(
      callbacks[1]!(buildEvent(), invalidTx),
    ).rejects.toThrow(/synthetic_apply_throw_in_fallback/);

    expect(tierUpgradeApplyPostPaidFailedMock).toHaveBeenCalledWith(
      'test-tenant',
    );
    expect(auditEmitterEmitMock).toHaveBeenCalledTimes(1);
    const [event, context] = auditEmitterEmitMock.mock.calls[0] ?? [];
    expect((event as { type?: string })?.type).toBe(
      'tier_upgrade_apply_post_invoice_paid_failed',
    );
    // Round 5 IMP-10 — lock actorRole='webhook'. F4-driven post-paid
    // hooks come from Stripe webhook context, NOT admin/system. Drift
    // here would mis-classify forensic-chain provenance.
    expect(context).toMatchObject({ actorRole: 'webhook' });
    // Audit succeeded → no fatal escalation.
    expect(loggerFatalMock).not.toHaveBeenCalled();
  });

  it('R4-IMP-6 + R4-SUG-4 fallback apply-throw + audit-emit-fail: logger.fatal w/ stable errorId', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValueOnce({
      cycleId: 'cyc-2',
      memberId: 'mem-2',
    });
    applyPendingTierUpgradeInTxMock.mockRejectedValueOnce(
      new Error('synthetic_apply_throw_audit_fail_chain'),
    );
    // Audit emit ALSO throws — production pgEnum drift / pinoFallback.
    auditEmitterEmitMock.mockRejectedValueOnce(
      new Error('synthetic_audit_emit_failure'),
    );

    const callbacks = f8OnPaidCallbacks('test-tenant');
    const invalidTx = { execute: vi.fn() };
    await expect(
      callbacks[1]!(buildEvent(), invalidTx),
    ).rejects.toThrow(/synthetic_apply_throw_audit_fail_chain/);

    // Counter still bumped before audit-emit attempt.
    expect(tierUpgradeApplyPostPaidFailedMock).toHaveBeenCalledWith(
      'test-tenant',
    );
    // logger.fatal is the load-bearing escalation signal.
    expect(loggerFatalMock).toHaveBeenCalledTimes(1);
    const [payload, message] = loggerFatalMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      errorId: 'F8.APPLY_TIER.POST_PAID_AUDIT_EMIT_FAILED',
      tenantId: 'test-tenant',
      invoiceId: expect.any(String),
      cycleId: 'cyc-2',
    });
    expect(message).toContain('manual replay required');
  });

  // ─────────────────────────────────────────────────────────────────
  // Round 6 W-012 — F4 webhook replay idempotency
  //
  // Stripe webhook delivery is at-least-once. F4's `markPaidFromProcessor`
  // is idempotent at the F4 layer (invoice already paid → second call
  // is a no-op). The F8 callback chain that runs inside the F4 tx must
  // ALSO be idempotent: a second `applyPendingTierUpgradeInTx` call
  // with the same cycleId must NOT double-apply the tier upgrade and
  // must NOT emit a duplicate `tier_upgrade_applied_at_renewal` audit.
  //
  // The use-case relies on `findPendingForCycle` returning ZERO rows
  // when the suggestion is already in `applied` status (the partial
  // index `pending_apply_idx` filters by `status='accepted_pending_apply'`).
  // This test asserts the callback is a no-op when the use-case is
  // called twice in succession.
  // ─────────────────────────────────────────────────────────────────

  it('W-012 F4 webhook replay — second call with already-applied suggestion is no-op (no double audit, no double mutation)', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-replay',
      memberId: 'mem-replay',
    });
    // Second call: applyPendingTierUpgradeInTx returns an EMPTY array
    // because findPendingForCycle finds zero rows (the first call
    // already transitioned the suggestion to `applied`, which the
    // partial index excludes). NOTE: the InTx variant returns a bare
    // `ReadonlyArray<SuggestionId>` (NOT the `{ suggestionsApplied }`
    // wrapper that the standalone `applyPendingTierUpgrade` returns) — the
    // callback's idempotency relies on this shape, so the mock MUST match
    // the real bare-array shape. (065 Fix A precision no longer reads
    // `.length` to gate — the F2 finaliser gates per-pending-row on the
    // linked suggestion status — but the bare-array shape still matters.)
    applyPendingTierUpgradeInTxMock
      .mockResolvedValueOnce(['sug-1'])
      .mockResolvedValueOnce([]);

    const callbacks = f8OnPaidCallbacks('test-tenant');

    // First webhook delivery — applies the tier upgrade.
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);
    // Second (replay) — must be a clean no-op.
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    expect(applyPendingTierUpgradeInTxMock).toHaveBeenCalledTimes(2);
    // Counter NOT bumped (apply succeeded both times — the second time
    // it succeeds with an empty `suggestionsApplied` array).
    expect(tierUpgradeApplyPostPaidFailedMock).not.toHaveBeenCalled();
    // logger.error / logger.fatal NOT fired — replay is a normal path.
    expect(loggerErrorMock).not.toHaveBeenCalled();
    expect(loggerFatalMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────
  // R2 Batch 3b (R2-I8) — F2 finaliser integration assertions.
  //
  // The Batch 2d helper-level unit test (`f8-onPaid-f2-finalise.test`)
  // covers `finaliseF2ScheduledPlanChangeForCycle` in isolation via
  // `_internal` export. This integration assertion pins the OUTER
  // callback factory's wiring:
  //   1. `resolvedCycleId` is captured from the in-tx cycle lookup.
  //   2. (065 Fix A precision) The `if (resolvedCycleId !== null)` caller
  //      gate invokes the F2 finaliser on every renewal-cycle invoice; the
  //      finaliser itself gates per-pending-row on the F2 row's OWN linked
  //      suggestion status (parsed from `reason` → `tierUpgradeRepo.findById`),
  //      skipping ONLY when THAT suggestion is `superseded` (the
  //      cancelled-upgrade orphan). This closes the re-accept precision hole
  //      a coarse cycle-wide probe missed.
  //   3. The `renewalsMetrics.f2FinaliseBeforeF4Commit` counter is
  //      bumped INSIDE the finaliser, after the per-row gate decides to
  //      proceed (i.e. only when a pending row exists AND its suggestion is
  //      not superseded).
  //   4. On non-renewal invoices (cycle === null short-circuit), the
  //      F2 finaliser MUST NOT be invoked + the metric MUST NOT bump.
  //   5. (065 Fix A precision) When the pending row's OWN linked suggestion
  //      is `superseded` (the cancelled-upgrade orphan), the finaliser
  //      SKIPS the transition — see the dedicated S6/Fix-A precision test
  //      below.
  // A refactor that drops the `resolvedCycleId = cycle.cycleId`
  // assignment at the apply()-closure site would fail (3).
  // ─────────────────────────────────────────────────────────────────

  it('R2-I8: F2 finaliser fires + metric bumps when renewal cycle resolved and pending F2 row exists', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-with-pending-plan-change',
      memberId: 'mem-1',
    });
    // InTx variant returns a bare array (065 S6 gate reads `.length`).
    applyPendingTierUpgradeInTxMock.mockResolvedValueOnce(['sug-A']);
    // F2 finaliser path: pending row exists for (member, cycle). Its
    // `reason` links to a suggestion that resolves `applied` (default
    // findById mock) → the per-row gate is OPEN.
    f2FindPendingForCycleMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-applied-target',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-with-pending-plan-change',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
      status: 'pending',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: null,
    });
    f2TransitionStatusMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-applied-target',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-with-pending-plan-change',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
      status: 'applied',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: '2026-05-19T10:00:00Z',
      supersededAt: null,
      cancelledAt: null,
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // F2 finaliser was invoked exactly once
    expect(f2FindPendingForCycleMock).toHaveBeenCalledTimes(1);
    expect(f2TransitionStatusMock).toHaveBeenCalledTimes(1);
    // Audit emit fires with plan_change_applied event_type + correct payload
    expect(f2AuditRecordMock).toHaveBeenCalledTimes(1);
    const [, event] = f2AuditRecordMock.mock.calls[0]!;
    expect((event as { event_type: string }).event_type).toBe(
      'plan_change_applied',
    );
    // R2-C1 operational counter — bumped exactly once (inside the finaliser,
    // after the per-row gate decided to proceed).
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledWith('test-tenant');
    // 065 Fix A precision — the gate signal is the PENDING ROW's OWN linked
    // suggestion status, resolved by `findById` from the `reason` id.
    expect(tierUpgradeFindByIdMock).toHaveBeenCalledWith(
      'test-tenant',
      LINKED_SUGGESTION_ID,
    );
  });

  it('R2-I8: F2 finaliser NOT invoked + metric NOT bumped when cycle is null (non-renewal invoice)', async () => {
    // Non-renewal invoice: cyclesRepo.findByInvoiceIdInTx returns null
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue(null);

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // F8 in-tx work skipped (cycle null short-circuit inside apply())
    expect(applyPendingTierUpgradeInTxMock).not.toHaveBeenCalled();
    // F2 finaliser MUST NOT fire (resolvedCycleId stays null)
    expect(f2FindPendingForCycleMock).not.toHaveBeenCalled();
    expect(f2TransitionStatusMock).not.toHaveBeenCalled();
    expect(f2AuditRecordMock).not.toHaveBeenCalled();
    // Counter MUST NOT bump
    expect(f2FinaliseBeforeF4CommitMock).not.toHaveBeenCalled();
  });

  it('065 Fix A precision: F2 finaliser SKIPS the transition when the pending row\'s OWN linked suggestion is SUPERSEDED (cancelled-upgrade orphan — no re-bill)', async () => {
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-superseded',
      memberId: 'mem-1',
    });
    // Apply no-ops: the suggestion was superseded, so no
    // `accepted_pending_apply` row for the cycle.
    applyPendingTierUpgradeInTxMock.mockResolvedValueOnce([]);
    // The orphan F2 pending row IS present (the supersede missed it) and
    // links to the suggestion that was superseded.
    f2FindPendingForCycleMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-orphan',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-superseded',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
      status: 'pending',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: null,
    });
    // The linked suggestion resolves `superseded` → the per-row gate must
    // SKIP the transition so the orphaned F2 pending row is never flipped
    // → applied (the S6 re-bill money bug).
    tierUpgradeFindByIdMock.mockResolvedValueOnce({ status: 'superseded' });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // The pending row WAS fetched + its suggestion resolved superseded →
    // the finaliser skips: NO counter bump, NO transition, NO audit.
    expect(f2FindPendingForCycleMock).toHaveBeenCalledTimes(1);
    expect(tierUpgradeFindByIdMock).toHaveBeenCalledWith(
      'test-tenant',
      LINKED_SUGGESTION_ID,
    );
    expect(f2FinaliseBeforeF4CommitMock).not.toHaveBeenCalled();
    expect(f2TransitionStatusMock).not.toHaveBeenCalled();
    expect(f2AuditRecordMock).not.toHaveBeenCalled();
  });

  it('065 Fix A (S1 retry-heal): apply returns [] (suggestion already applied) but NOT superseded → finaliser STILL runs + heals the stranded F2 row', async () => {
    // Webhook re-delivery (Stripe at-least-once): the FIRST delivery
    // applied the F8 suggestion (→ `applied`) but its post-tx F2
    // finaliser failed transiently, leaving the F2 row `pending`. On the
    // retry the apply finds the suggestion ALREADY `applied` and returns
    // [] — the OLD `appliedSuggestionCount > 0` gate would skip the
    // finaliser, stranding the F2 row in `pending` forever. The NEW gate
    // keys on suggestion STATUS: not superseded → the finaliser runs +
    // heals the stranded row.
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-retry-heal',
      memberId: 'mem-1',
    });
    // Retry: apply no-ops (already-applied suggestion → []).
    applyPendingTierUpgradeInTxMock.mockResolvedValueOnce([]);
    // The F2 row is still `pending` (the strand the retry must heal).
    f2FindPendingForCycleMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-strand',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-retry-heal',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: `tier_upgrade_accepted:${STRAND_SUGGESTION_ID}`,
      status: 'pending',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: null,
    });
    // The linked suggestion is `applied` (NOT superseded) — a normally-
    // applied upgrade whose F2 finaliser failed on the prior delivery. The
    // per-row gate is OPEN → the retry heals the stranded row.
    tierUpgradeFindByIdMock.mockResolvedValueOnce({ status: 'applied' });
    f2TransitionStatusMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-strand',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-retry-heal',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: `tier_upgrade_accepted:${STRAND_SUGGESTION_ID}`,
      status: 'applied',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: '2026-05-19T10:00:00Z',
      supersededAt: null,
      cancelledAt: null,
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // The finaliser ran despite the empty apply result — the per-row gate
    // keyed on the pending row's own suggestion (applied, not superseded).
    expect(tierUpgradeFindByIdMock).toHaveBeenCalledWith(
      'test-tenant',
      STRAND_SUGGESTION_ID,
    );
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(f2FindPendingForCycleMock).toHaveBeenCalledTimes(1);
    expect(f2TransitionStatusMock).toHaveBeenCalledTimes(1);
    expect(f2AuditRecordMock).toHaveBeenCalledTimes(1);
    const [, event] = f2AuditRecordMock.mock.calls[0]!;
    expect((event as { event_type: string }).event_type).toBe(
      'plan_change_applied',
    );
  });

  it('065 Fix A precision (same-tier renewal): no pending F2 row → finaliser is a clean no-op (no findById, no counter, no transition)', async () => {
    // The common same-tier-renewal case: a cycle resolved but no plan
    // switch scheduled. The finaliser fetches the pending row, finds none,
    // and no-ops BEFORE any suggestion lookup or counter bump.
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-standalone',
      memberId: 'mem-1',
    });
    applyPendingTierUpgradeInTxMock.mockResolvedValueOnce([]);
    // No pending F2 row (explicit) → finaliser no-ops at the null check.
    f2FindPendingForCycleMock.mockResolvedValueOnce(null);

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // Finaliser entered + queried for a pending row, but found none →
    // clean no-op: NO suggestion lookup, NO counter bump (it moved inside
    // the finaliser, after the pending-row check), NO transition/audit.
    expect(f2FindPendingForCycleMock).toHaveBeenCalledTimes(1);
    expect(tierUpgradeFindByIdMock).not.toHaveBeenCalled();
    expect(f2FinaliseBeforeF4CommitMock).not.toHaveBeenCalled();
    expect(f2TransitionStatusMock).not.toHaveBeenCalled();
    expect(f2AuditRecordMock).not.toHaveBeenCalled();
  });

  it('065 Fix A precision (standalone schedule — no suggestion link): pending row whose reason has no `tier_upgrade_accepted:` prefix → finaliser proceeds without a findById lookup', async () => {
    // A future admin-scheduled plan change (no F8 suggestion) writes a
    // `reason` that does NOT match the `tier_upgrade_accepted:` prefix.
    // `parseSuggestionIdFromReason` returns null → the per-row gate treats
    // it as "standalone — proceed" WITHOUT a findById lookup.
    cyclesRepoFindByInvoiceIdInTxMock.mockResolvedValue({
      cycleId: 'cyc-standalone-schedule',
      memberId: 'mem-1',
    });
    applyPendingTierUpgradeInTxMock.mockResolvedValueOnce([]);
    f2FindPendingForCycleMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-standalone',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-standalone-schedule',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: 'admin_manual_schedule',
      status: 'pending',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: null,
    });
    f2TransitionStatusMock.mockResolvedValueOnce({
      tenantId: 'test-tenant',
      scheduledChangeId: 'sched-standalone',
      memberId: '22222222-2222-2222-2222-222222222222',
      effectiveAtCycleId: 'cyc-standalone-schedule',
      fromPlanId: 'corporate-standard',
      toPlanId: 'corporate-premium',
      scheduledByUserId: 'admin',
      reason: 'admin_manual_schedule',
      status: 'applied',
      scheduledAt: '2026-05-01T00:00:00Z',
      appliedAt: '2026-05-19T10:00:00Z',
      supersededAt: null,
      cancelledAt: null,
    });

    const callbacks = f8OnPaidCallbacks('test-tenant');
    await callbacks[1]!(buildEvent(), fakeValidTenantTx);

    // Standalone (no prefix) → no findById lookup, but the finaliser
    // proceeds: counter bumped + transition + audit.
    expect(f2FindPendingForCycleMock).toHaveBeenCalledTimes(1);
    expect(tierUpgradeFindByIdMock).not.toHaveBeenCalled();
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(f2TransitionStatusMock).toHaveBeenCalledTimes(1);
    expect(f2AuditRecordMock).toHaveBeenCalledTimes(1);
  });
});
