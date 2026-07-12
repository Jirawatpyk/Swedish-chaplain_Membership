/**
 * F8 Phase 3 Wave H2 · T059 spec — `markPaidOffline` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path).
 *
 * F4 chain mocked via the bridge port (no real F4 deps); the real
 * tx + atomicity is exercised by the H5 integration test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { markPaidOffline } from '@/modules/renewals/application/use-cases/mark-paid-offline';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { ThbDecimal } from '@/lib/money';
import type { EmailDispatchOutcome } from '@/modules/invoicing';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c4';
const TENANT_ID = 'tenantA';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => {
    const fakeTx = {
      execute: vi.fn(async () => ({ rows: [] })),
    };
    return fn(fakeTx as unknown);
  },
}));

// 070 speckit-review C1 — capture `logger.error` so the OFFLINE outer-catch
// belt-and-braces test can assert the `OFFLINE_FINALISE_THREW` log fired with
// the cycleId/invoiceId/memberId replay context. The rest of the logger is
// preserved (warn/info/debug) so unrelated paths stay silent.
const { loggerErrorMock } = vi.hoisted(() => ({ loggerErrorMock: vi.fn() }));
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  return {
    ...actual,
    logger: { ...actual.logger, error: loggerErrorMock },
  };
});

// 070 speckit-review C1 — mock `finaliseF2PlanChangeOnPaid` ITSELF so a test
// can drive the POST-commit OUTER belt-and-braces catch in `mark-paid-offline`
// (errorId `F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW`). By default it delegates to
// the real helper (the 070 Item-D finalise tests below exercise the genuine
// internal-swallow behaviour). A single test re-points it at a throwing impl.
// (The helper's OWN swallow-only internals are covered directly in
// `finalise-f2-plan-change-on-paid.test.ts`.)
const { finaliseF2Mock } = vi.hoisted(() => ({ finaliseF2Mock: vi.fn() }));
vi.mock(
  '@/modules/renewals/application/use-cases/finalise-f2-plan-change-on-paid',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/modules/renewals/application/use-cases/finalise-f2-plan-change-on-paid')
      >();
    finaliseF2Mock.mockImplementation(actual.finaliseF2PlanChangeOnPaid);
    return {
      ...actual,
      finaliseF2PlanChangeOnPaid: (...args: unknown[]) =>
        finaliseF2Mock(...args),
    };
  },
);

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(VALID_UUID),
    ...overrides,
  });
}

interface FakeDepsResult {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  bridgeMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  // 068-f8-completion (slice 1) — renewal-loop closer wiring. The offline
  // `onPaid` now also calls `createNextCycleOnPaidInTx`, which resolves the
  // prior cycle by linked invoice (`findByInvoiceIdInTx`), checks the
  // in-tx active guard (`findActiveForMemberInTx`), looks up the frozen
  // plan price (`planLookupForRenewal.loadPlanFrozenFields`) and inserts
  // the next cycle (`insert`). These mocks expose those calls so the
  // happy-path tests can assert the renewal loop is closed.
  insertMock: ReturnType<typeof vi.fn>;
  findByInvoiceIdInTxMock: ReturnType<typeof vi.fn>;
  findActiveForMemberInTxMock: ReturnType<typeof vi.fn>;
  loadPlanFrozenFieldsMock: ReturnType<typeof vi.fn>;
  // 070 Item D — tier-upgrade apply (in-tx, callback[1]-equivalent) +
  // post-commit F2 scheduled-plan-change finalise wiring. These mocks
  // expose those seams so the tests can assert the upgrade is applied
  // BEFORE the next-cycle insert and the F2 finalise runs post-commit.
  findPendingForCycleSuggestionMock: ReturnType<typeof vi.fn>;
  suggestionTransitionStatusMock: ReturnType<typeof vi.fn>;
  f2FindPendingForCycleMock: ReturnType<typeof vi.fn>;
  f2TransitionStatusMock: ReturnType<typeof vi.fn>;
  f2RecordMock: ReturnType<typeof vi.fn>;
  tierUpgradeFindByIdMock: ReturnType<typeof vi.fn>;
  // Task 7 (rolling-anchor) — shared-classifier + re-anchor seams.
  countCyclesForMemberInTxMock: ReturnType<typeof vi.fn>;
  // F2 fix (final-review, 2026-07-09) — settled-history discriminator.
  countSettledCyclesForMemberInTxMock: ReturnType<typeof vi.fn>;
  readReactivationGuardsInTxMock: ReturnType<typeof vi.fn>;
  reanchorPeriodInTxMock: ReturnType<typeof vi.fn>;
}

function fakeDeps(
  cycle: RenewalCycle | null,
  bridgeImpl?: (input: {
    paymentDate: string;
    onPaid?: (evt: {
      tenantId: string;
      invoiceId: string;
      memberId: string;
      paidAt: string;
      amountSatang: bigint;
      vatSatang: bigint;
      currency: 'THB';
      paymentMethod: 'bank_transfer' | 'cash' | 'cheque';
      triggeredBy: 'admin_offline_mark';
      readonly invoiceSubject: 'membership' | 'event';
      readonly paymentDate: string | null;
    }) => Promise<void>;
  }) => Promise<unknown>,
  // Cluster 5 (Finding 1) parity — the observable auto-email outcome the F4
  // bridge now carries back on the success value. Defaults to 'sent' (member
  // WITH a contact email — the common case) so every pre-existing test stays
  // byte-identical; the no-email-skip tests pass 'skipped_no_email'.
  emailDispatch: EmailDispatchOutcome = 'sent',
): FakeDepsResult {
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(async () => {});
  const transitionMock = vi.fn(async () => ({ ...cycle!, status: 'completed' }));
  const defaultBridge = async (input: {
    paymentDate: string;
    onPaid?: (evt: {
      tenantId: string;
      invoiceId: string;
      memberId: string;
      paidAt: string;
      amountSatang: bigint;
      vatSatang: bigint;
      currency: 'THB';
      paymentMethod: 'bank_transfer' | 'cash' | 'cheque';
      triggeredBy: 'admin_offline_mark';
      readonly invoiceSubject: 'membership' | 'event';
      readonly paymentDate: string | null;
    }) => Promise<void>;
  }) => {
    const evt = {
      tenantId: TENANT_ID,
      invoiceId: 'inv-1',
      memberId: cycle?.memberId ?? 'mem-1',
      paidAt: '2026-05-15T10:00:00Z',
      amountSatang: 5000000n,
      vatSatang: 350000n,
      currency: 'THB' as const,
      paymentMethod: 'bank_transfer' as const,
      triggeredBy: 'admin_offline_mark' as const,
      invoiceSubject: 'membership' as const,
      paymentDate: input.paymentDate,
    };
    if (input.onPaid) await input.onPaid(evt);
    return {
      ok: true,
      value: { invoiceId: 'inv-1', paidAt: evt.paidAt, emailDispatch },
    };
  };
  const bridgeMock = vi.fn(bridgeImpl ?? defaultBridge);
  // 068-f8-completion — next-cycle wiring. `findByInvoiceIdInTx` resolves
  // the prior (now-completed) cycle so the on-paid creator anchors the
  // next cycle at its periodTo; `findActiveForMemberInTx` returns null so
  // the idempotency guard proceeds; `loadPlanFrozenFields` returns a found
  // plan so the frozen price resolves; `insert` records the next cycle.
  const findByInvoiceIdInTxMock = vi.fn(async () =>
    cycle ? { ...cycle, status: 'completed' as const } : null,
  );
  const findActiveForMemberInTxMock = vi.fn(async () => null);
  const insertMock = vi.fn(async () =>
    buildCycle({ status: 'upcoming', cycleId: asCycleId(VALID_UUID) }),
  );
  const loadPlanFrozenFieldsMock = vi.fn(async () => ({
    status: 'found' as const,
    plan: {
      tierBucket: 'regular' as const,
      priceTHB: '50000.00',
      termMonths: 12,
      currency: 'THB' as const,
    },
  }));
  // 070 Item D — tier-upgrade apply (in-tx) seam. Default: no pending
  // suggestion for the cycle, so the apply is a clean no-op (the existing
  // happy-path / error-path tests stay green). A targeted test overrides
  // `findPendingForCycleSuggestionMock` to drive the apply.
  const findPendingForCycleSuggestionMock = vi.fn(
    async () => [] as ReadonlyArray<unknown>,
  );
  const suggestionTransitionStatusMock = vi.fn(async () => {});
  const tierUpgradeFindByIdMock = vi.fn(async () => null);
  // 070 Item D — post-commit F2 scheduled-plan-change finalise seam.
  // Default: no pending F2 row, so the finalise is a clean no-op.
  const f2FindPendingForCycleMock = vi.fn(async () => null);
  const f2TransitionStatusMock = vi.fn(async (_t, scheduledChangeId) => ({
    scheduledChangeId,
    status: 'applied' as const,
  }));
  const f2RecordMock = vi.fn(async () => ({ ok: true as const, value: undefined }));
  // Task 7 (rolling-anchor refactor) — shared-classifier seams. Default
  // count=2 (has a predecessor cycle) + not erased/blocked, so EVERY
  // pre-existing test (which never overrides these) stays on the
  // 'completed' branch byte-identical to before Task 7. Individual Task 7
  // tests override `countCyclesForMemberInTxMock` to 1 to drive the
  // first_payment classification.
  const countCyclesForMemberInTxMock = vi.fn(async () => 2);
  // F2 fix (final-review, 2026-07-09) — default 1 (the assumed predecessor
  // IS settled) so every pre-existing test stays on 'renewal' /
  // 'completed' byte-identically. Task 7 tests that flip
  // `countCyclesForMemberInTxMock` to 1 to force first_payment must ALSO
  // flip this to 0 (see that describe block below).
  const countSettledCyclesForMemberInTxMock = vi.fn(async () => 1);
  const readReactivationGuardsInTxMock = vi.fn(async () => ({
    blocked: false,
    erased: false,
  }));
  // Echoes the guarded-UPDATE's args back as the "re-anchored" cycle row
  // (status flips to upcoming, linkedInvoiceId cleared) — mirrors the real
  // `reanchorPeriodInTx` contract closely enough for the use-case's own
  // branch logic (it never inspects fields beyond what it wrote).
  const reanchorPeriodInTxMock = vi.fn(
    async (
      _tx: unknown,
      _tenantId: string,
      _cycleId: unknown,
      args: {
        periodFrom: string;
        periodTo: string;
        anchoredAt: string;
        anchorInvoiceId: string | null;
        frozenPlanPriceThb: ThbDecimal;
        frozenPlanTermMonths: number;
      },
    ) => ({
      cycle: buildCycle({
        status: 'upcoming' as const,
        periodFrom: args.periodFrom,
        periodTo: args.periodTo,
        anchoredAt: args.anchoredAt,
        anchorInvoiceId: args.anchorInvoiceId,
        linkedInvoiceId: null,
        frozenPlanPriceThb: args.frozenPlanPriceThb,
        frozenPlanTermMonths: args.frozenPlanTermMonths,
      }),
      reminderEventsReset: 0,
    }),
  );
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    clock: { now: () => new Date('2026-05-15T10:00:00.000Z') },
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
      findByIdInTx: vi.fn(async () => cycle),
      transitionStatus: transitionMock,
      acquireCycleLockInTx: vi.fn(async () => {}),
      findByInvoiceIdInTx: findByInvoiceIdInTxMock,
      findActiveForMemberInTx: findActiveForMemberInTxMock,
      insert: insertMock,
      countCyclesForMemberInTx: countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTx: countSettledCyclesForMemberInTxMock,
      reanchorPeriodInTx: reanchorPeriodInTxMock,
    } as unknown as RenewalsDeps['cyclesRepo'],
    f4InvoiceBridge: {
      issueAndMarkPaid: bridgeMock,
    } as unknown as RenewalsDeps['f4InvoiceBridge'],
    auditEmitter: { emit: emitMock, emitInTx: emitInTxMock },
    planLookupForRenewal: {
      loadPlanFrozenFields: loadPlanFrozenFieldsMock,
    } as unknown as RenewalsDeps['planLookupForRenewal'],
    // FIX-3 (PR #173 review, 2026-07-09) — January default; no test in this
    // file exercises a non-January-start tenant's re-freeze decision.
    fiscalYearSettings: {
      getFiscalYearStartMonthInTx: vi.fn(async () => 1),
    } as unknown as RenewalsDeps['fiscalYearSettings'],
    // Task 7 (rolling-anchor refactor) — GDPR-erased + admin-blocked guard
    // read the classify step consumes. Default both false (see the mock
    // definition above) so pre-existing tests are unaffected.
    memberRenewalFlagsRepo: {
      readReactivationGuardsInTx: readReactivationGuardsInTxMock,
    } as unknown as RenewalsDeps['memberRenewalFlagsRepo'],
    // 070 Item D — tier-upgrade suggestion repo (apply-pending-tier-upgrade)
    // + F2 scheduled-plan-change repo + F2 audit emitter (post-commit
    // finalise). Defaults make both a no-op so untouched tests stay green.
    tierUpgradeRepo: {
      findPendingForCycle: findPendingForCycleSuggestionMock,
      transitionStatus: suggestionTransitionStatusMock,
      findById: tierUpgradeFindByIdMock,
    } as unknown as RenewalsDeps['tierUpgradeRepo'],
    scheduledPlanChangeRepo: {
      findPendingForCycle: f2FindPendingForCycleMock,
      transitionStatus: f2TransitionStatusMock,
    } as unknown as RenewalsDeps['scheduledPlanChangeRepo'],
    f2AuditEmitter: {
      record: f2RecordMock,
    } as unknown as RenewalsDeps['f2AuditEmitter'],
    // 068 speckit-review DRY (simplify #1) — the use-case now reads the
    // cycle-id generator from `deps.cycleIdFactory` (was an inline literal).
    // Provide a deterministic generator so the next-cycle insert resolves.
    cycleIdFactory: { cycleId: () => asCycleId(VALID_UUID) },
  } as unknown as RenewalsDeps;
  return {
    deps,
    emitMock,
    emitInTxMock,
    bridgeMock,
    transitionMock,
    insertMock,
    findByInvoiceIdInTxMock,
    findActiveForMemberInTxMock,
    loadPlanFrozenFieldsMock,
    findPendingForCycleSuggestionMock,
    suggestionTransitionStatusMock,
    f2FindPendingForCycleMock,
    f2TransitionStatusMock,
    f2RecordMock,
    tierUpgradeFindByIdMock,
    countCyclesForMemberInTxMock,
    countSettledCyclesForMemberInTxMock,
    readReactivationGuardsInTxMock,
    reanchorPeriodInTxMock,
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: VALID_UUID,
  paymentMethod: 'bank_transfer' as const,
  paymentReference: 'BT-2026-0042',
  paymentDate: '2026-05-15',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('markPaidOffline (T059) — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flips cycle to completed + emits audit + returns new expires_at', async () => {
    const cycle = buildCycle();
    const { deps, emitInTxMock, transitionMock } = fakeDeps(cycle);
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Task 7 — the pre-existing (non-first-payment) path returns the
      // 'completed' outcome discriminator, byte-identical to before.
      expect(r.value.outcome).toBe('completed');
      expect(r.value.cycleStatus).toBe('completed');
      expect(r.value.invoiceId).toBe('inv-1');
      expect(r.value.newExpiresAt).toBe('2028-06-01T00:00:00.000Z');
      // Cluster 5 (Finding 1) parity — the auto-email outcome the F4 bridge
      // computed at payment is surfaced on the Output. Default member has an
      // email on file → 'sent' (no warning).
      expect(r.value.emailDispatch).toBe('sent');
    }
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![3]).toEqual(
      expect.objectContaining({
        from: 'awaiting_payment',
        to: 'completed',
        closedReason: 'completed_offline',
        linkedInvoiceId: 'inv-1',
      }),
    );
    expect(emitInTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: 'renewal_cycle_completed_offline' }),
      expect.any(Object),
    );
  });

  // Cluster 5 (Finding 1) parity — G10 for the 4th money path. When the F4
  // bridge issues the §86/4 receipt but the payment-time auto-email is
  // SKIPPED (imported member with no contact email on file), the outcome must
  // reach the Output so the route + admin toast can warn "receipt not emailed".
  it('propagates a skipped_no_email auto-email outcome through the completed Output', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, undefined, 'skipped_no_email');
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('completed');
      expect(r.value.emailDispatch).toBe('skipped_no_email');
    }
  });

  it('accepts both payable cycle statuses (upcoming + awaiting_payment)', async () => {
    for (const status of ['upcoming', 'awaiting_payment'] as const) {
      const { deps } = fakeDeps(buildCycle({ status }));
      const r = await markPaidOffline(deps, baseInput);
      expect(r.ok).toBe(true);
    }
  });

  // 068-f8-completion (slice 1) — renewal-loop closer on the OFFLINE path.
  // The offline `onPaid` now ALSO creates the next cycle (reusing
  // `createNextCycleOnPaidInTx`), so a bank-transfer renewal stays in the
  // pipeline instead of silently dropping out. Assert the next-cycle
  // insert fires AFTER the completion flip, inside the same tx.
  it('creates the next renewal cycle on the offline path (insert fires after the completion flip)', async () => {
    const cycle = buildCycle();
    const { deps, insertMock, transitionMock, findByInvoiceIdInTxMock } =
      fakeDeps(cycle);
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    // Next cycle was inserted exactly once.
    expect(insertMock).toHaveBeenCalledTimes(1);
    // It anchored on the prior cycle resolved by the paid invoice.
    expect(findByInvoiceIdInTxMock).toHaveBeenCalledTimes(1);
    // Completion flip happened before the next-cycle insert (same tx).
    const transitionOrder = transitionMock.mock.invocationCallOrder[0]!;
    const insertOrder = insertMock.mock.invocationCallOrder[0]!;
    expect(transitionOrder).toBeLessThan(insertOrder);
  });

  // THROW-on-failure: if next-cycle creation fails (e.g. plan no longer
  // resolvable), the offline-mark tx rolls back and the admin gets an
  // error to retry — the renewal loop must never silently half-complete.
  it('rolls back to server_error if next-cycle creation fails (no silent half-complete)', async () => {
    const cycle = buildCycle();
    const { deps, loadPlanFrozenFieldsMock } = fakeDeps(cycle);
    // createCycleInTx throws when the plan is not resolvable.
    loadPlanFrozenFieldsMock.mockResolvedValueOnce({ status: 'not_found' });
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });
});

// ───────────────────────────────────────────────────────────────────────
// 070 Item D — tier-upgrade apply on the OFFLINE path. The offline `onPaid`
// now mirrors the online `f8OnPaidCallbacks[1]`: it applies any pending
// tier-upgrade IN-TX (callback[1]-equivalent) BEFORE the next-cycle insert
// (callback[2]-equivalent), then finalises the F2 scheduled-plan-change row
// POST-commit. The actor for both is the ADMIN (offline settlement), not a
// webhook.
// ───────────────────────────────────────────────────────────────────────
describe('markPaidOffline (070 Item D) — pending tier-upgrade apply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const PENDING_SUGGESTION = {
    suggestionId: '99999999-9999-9999-9999-999999999999',
    memberId: 'mem-1',
    fromPlanId: 'regular',
    toPlanId: 'premium',
    status: 'accepted_pending_apply' as const,
  };

  it('applies the pending tier-upgrade IN-TX before the next-cycle insert (suggestion→applied)', async () => {
    const cycle = buildCycle({ memberId: 'mem-1' });
    const {
      deps,
      findPendingForCycleSuggestionMock,
      suggestionTransitionStatusMock,
      insertMock,
    } = fakeDeps(cycle);
    findPendingForCycleSuggestionMock.mockResolvedValueOnce([
      PENDING_SUGGESTION,
    ]);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);

    // The suggestion was transitioned → applied exactly once.
    expect(suggestionTransitionStatusMock).toHaveBeenCalledTimes(1);
    const transitionArgs = suggestionTransitionStatusMock.mock.calls[0]!;
    // args: (tx, tenantId, suggestionId, { to, expectedFrom, ... })
    expect(transitionArgs[3]).toEqual(
      expect.objectContaining({
        to: 'applied',
        expectedFrom: 'accepted_pending_apply',
        appliedAtInvoiceId: 'inv-1',
      }),
    );

    // Ordering: the apply transition fires BEFORE the next-cycle insert
    // (callback[1] before callback[2]).
    const applyOrder =
      suggestionTransitionStatusMock.mock.invocationCallOrder[0]!;
    const insertOrder = insertMock.mock.invocationCallOrder[0]!;
    expect(applyOrder).toBeLessThan(insertOrder);
  });

  it('emits tier_upgrade_applied_at_renewal under the ADMIN actor (not webhook)', async () => {
    const cycle = buildCycle({ memberId: 'mem-1' });
    const { deps, emitInTxMock, findPendingForCycleSuggestionMock } =
      fakeDeps(cycle);
    findPendingForCycleSuggestionMock.mockResolvedValueOnce([
      PENDING_SUGGESTION,
    ]);

    await markPaidOffline(deps, baseInput);

    const applyAuditCall = emitInTxMock.mock.calls.find(
      (c) =>
        (c[1] as { type?: string })?.type === 'tier_upgrade_applied_at_renewal',
    );
    expect(applyAuditCall).toBeDefined();
    // ctx is the 3rd arg — the offline path carries the admin actor.
    expect(applyAuditCall![2]).toEqual(
      expect.objectContaining({
        actorUserId: 'admin-1',
        actorRole: 'admin',
      }),
    );
  });

  it('finalises the F2 scheduled-plan-change POST-commit under the ADMIN actor', async () => {
    const cycle = buildCycle({ memberId: 'mem-1' });
    const {
      deps,
      findPendingForCycleSuggestionMock,
      f2FindPendingForCycleMock,
      f2TransitionStatusMock,
      f2RecordMock,
    } = fakeDeps(cycle);
    findPendingForCycleSuggestionMock.mockResolvedValueOnce([
      PENDING_SUGGESTION,
    ]);
    // A pending F2 row whose `reason` links to no suggestion (standalone)
    // so the finaliser proceeds without a findById gate.
    f2FindPendingForCycleMock.mockResolvedValueOnce({
      scheduledChangeId: 'sched-1',
      memberId: 'mem-1',
      reason: 'admin_manual_schedule',
      fromPlanId: 'regular',
      toPlanId: 'premium',
    });

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);

    // F2 row flipped pending → applied.
    expect(f2TransitionStatusMock).toHaveBeenCalledTimes(1);
    expect(f2TransitionStatusMock.mock.calls[0]![2]).toBe('applied');
    // plan_change_applied audit recorded under the admin actor.
    expect(f2RecordMock).toHaveBeenCalledTimes(1);
    const f2Ctx = f2RecordMock.mock.calls[0]![0] as { actorUserId?: string };
    expect(f2Ctx.actorUserId).toBe('admin-1');
    const f2Event = f2RecordMock.mock.calls[0]![1] as { event_type?: string };
    expect(f2Event.event_type).toBe('plan_change_applied');
  });

  it('rolls back to server_error when the in-tx tier-upgrade apply throws (no silent strand)', async () => {
    const cycle = buildCycle({ memberId: 'mem-1' });
    const { deps, findPendingForCycleSuggestionMock, suggestionTransitionStatusMock } =
      fakeDeps(cycle);
    findPendingForCycleSuggestionMock.mockResolvedValueOnce([
      PENDING_SUGGESTION,
    ]);
    // A real (non-CAS) error inside the apply rolls the offline-mark tx back.
    suggestionTransitionStatusMock.mockRejectedValueOnce(
      new Error('db connection lost mid-apply'),
    );

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('does NOT fail the use-case when the post-commit F2 finalise THROWS to the OUTER catch (payment already durable; OFFLINE_FINALISE_THREW logged)', async () => {
    // 070 speckit-review C1 — exercise the use-case's OUTER belt-and-braces
    // catch around `finaliseF2PlanChangeOnPaid` (mark-paid-offline.ts errorId
    // `F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW`). The PRIOR version rejected the
    // helper's INTERNAL `findPendingForCycle` mock, but that rejection is
    // swallowed INSIDE the (swallow-only) helper and never reaches this outer
    // catch — so the catch arm was untested. Mock the WHOLE helper to throw so
    // the throw actually propagates to the use-case's own try/catch.
    const cycle = buildCycle({ memberId: 'mem-1' });
    const { deps } = fakeDeps(cycle);
    // The helper itself throws (a future regression that breaks its internal
    // swallow-only discipline, or a synchronous throw before its own try/catch).
    finaliseF2Mock.mockRejectedValueOnce(
      new Error('finalise threw past its internal swallow'),
    );

    const r = await markPaidOffline(deps, baseInput);
    // (a) The payment is already committed — the use-case must NOT downgrade to
    // server_error; it returns ok.
    expect(r.ok).toBe(true);

    // (b) The OFFLINE_FINALISE_THREW error log fired with the replay context
    // (cycleId + invoiceId + memberId) so an operator can grep + manually
    // replay the stranded F2 row (the offline rail has no webhook retry).
    const offlineFinaliseLog = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { errorId?: string } | undefined)?.errorId ===
        'F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW',
    );
    expect(offlineFinaliseLog).toBeDefined();
    expect(offlineFinaliseLog![0]).toMatchObject({
      errorId: 'F2.PLAN_CHANGE.OFFLINE_FINALISE_THREW',
      cycleId: VALID_UUID,
      invoiceId: 'inv-1',
      memberId: 'mem-1',
      tenantId: TENANT_ID,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────
// Task 7 (rolling-anchor refactor, design 2026-07-08 rev 3, migration
// 0238, spec §1 consuming-site 3) — the SAME shared `classifyMembershipPayment`
// every settlement site consumes now classifies mark-paid-offline's target
// cycle too. A `first_payment` result (member's one-and-only cycle,
// `anchored_at IS NULL`) RE-ANCHORS instead of completing; every other
// classification keeps the pre-existing `completed` behaviour
// byte-identical.
// ───────────────────────────────────────────────────────────────────────
describe('markPaidOffline (Task 7 rolling-anchor) — first-payment re-anchor branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-anchors (not completes) the member’s only-ever, never-anchored cycle', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
      reanchorPeriodInTxMock,
      transitionMock,
      emitInTxMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0);

    const r = await markPaidOffline(deps, baseInput);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('reanchored');
      expect(r.value.cycleStatus).toBe('upcoming');
    }
    // Never transitions the cycle to completed on this branch.
    expect(transitionMock).not.toHaveBeenCalled();
    // The shared re-anchor guard fired exactly once.
    expect(reanchorPeriodInTxMock).toHaveBeenCalledTimes(1);
    // renewal_cycle_reanchored fired; renewal_cycle_completed_offline did NOT.
    const emittedTypes = emitInTxMock.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(emittedTypes).toContain('renewal_cycle_reanchored');
    expect(emittedTypes).not.toContain('renewal_cycle_completed_offline');
  });

  // Cluster 5 (Finding 1) parity — the auto-email outcome must also thread
  // through the SECOND Output variant (reanchored), not just completed. A
  // first-payment imported member with no email must still surface the skip.
  it('propagates a skipped_no_email auto-email outcome through the reanchored Output', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
    } = fakeDeps(cycle, undefined, 'skipped_no_email');
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('reanchored');
      expect(r.value.emailDispatch).toBe('skipped_no_email');
    }
  });

  it('creates NO next cycle on the re-anchor branch (createNextCycleOnPaidInTx no-ops)', async () => {
    // Mirrors the real `reanchorPeriodInTx` contract: the guarded UPDATE
    // clears `linked_invoice_id`, so `createNextCycleOnPaidInTx`'s own
    // `findByInvoiceIdInTx(evt.invoiceId)` lookup resolves to null —
    // asserted here by overriding the SAME mock the completed-branch tests
    // use to simulate "prior cycle resolved by invoice id".
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
      findByInvoiceIdInTxMock,
      insertMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0);
    findByInvoiceIdInTxMock.mockResolvedValue(null);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("newExpiresAt on the reanchor branch is the re-anchored cycle’s OWN periodTo (never hand-recomputed)", async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
      reanchorPeriodInTxMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(reanchorPeriodInTxMock).toHaveBeenCalledTimes(1);
    const writtenArgs = reanchorPeriodInTxMock.mock.calls[0]![3] as {
      periodTo: string;
      periodFrom: string;
    };
    if (r.ok) {
      expect(r.value.newExpiresAt).toBe(writtenArgs.periodTo);
      // RRA task 7 fix — newPeriodFrom must be present on reanchored branch
      expect(r.value.outcome).toBe("reanchored");
      if (r.value.outcome === "reanchored") {
        expect(r.value.newPeriodFrom).toBe(writtenArgs.periodFrom);
      }
    }
  });

  it('a member with a predecessor cycle (count!==1) stays on the completed branch — byte-identical', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const { deps, countCyclesForMemberInTxMock, transitionMock, emitInTxMock } =
      fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(3); // has renewal history

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('completed');
      expect(r.value.cycleStatus).toBe('completed');
    }
    expect(transitionMock).toHaveBeenCalledTimes(1);
    const emittedTypes = emitInTxMock.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(emittedTypes).toContain('renewal_cycle_completed_offline');
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history" — re-anchors, not completes.
  it('a member with an UNSETTLED predecessor cycle (cancelled, never anchored) still re-anchors — first_payment despite count!==1', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
      reanchorPeriodInTxMock,
      transitionMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(2); // a predecessor row exists...
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0); // ...but never settled

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('reanchored');
    expect(reanchorPeriodInTxMock).toHaveBeenCalledTimes(1);
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('an already-anchored cycle (anchored_at set) stays on the completed branch even with count===1', async () => {
    const cycle = buildCycle({ anchoredAt: '2026-01-01T00:00:00Z' });
    const { deps, countCyclesForMemberInTxMock, transitionMock } =
      fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('completed');
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('a GDPR-erased member never re-anchors even when the cycle is otherwise first-payment-shaped', async () => {
    // Design rev 2 §1: erased members never auto-anchor/renew. Falling
    // through to the pre-existing `completed` behaviour (rather than a new
    // error kind) matches every other settlement site's `not_applicable`
    // handling — the classify call here exists ONLY to detect the
    // first-payment shape, not to gate the whole use-case.
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      readReactivationGuardsInTxMock,
      transitionMock,
      reanchorPeriodInTxMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    readReactivationGuardsInTxMock.mockResolvedValue({
      blocked: false,
      erased: true,
    });

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('completed');
    expect(reanchorPeriodInTxMock).not.toHaveBeenCalled();
    expect(transitionMock).toHaveBeenCalledTimes(1);
  });

  it('rolls back to server_error when the re-anchor guard loses the race (0 rows — contract-regression alarm)', async () => {
    const cycle = buildCycle({ anchoredAt: null });
    const {
      deps,
      countCyclesForMemberInTxMock,
      countSettledCyclesForMemberInTxMock,
      reanchorPeriodInTxMock,
    } = fakeDeps(cycle);
    countCyclesForMemberInTxMock.mockResolvedValue(1);
    countSettledCyclesForMemberInTxMock.mockResolvedValue(0);
    reanchorPeriodInTxMock.mockResolvedValueOnce(null);

    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });
});

describe('markPaidOffline — error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid_input on bad cycleId', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await markPaidOffline(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
  });

  it('returns invalid_input on bad payment_date format', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await markPaidOffline(deps, {
      ...baseInput,
      paymentDate: '15-05-2026',
    });
    expect(r.ok).toBe(false);
  });

  it('returns invalid_input on empty payment_reference', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await markPaidOffline(deps, {
      ...baseInput,
      paymentReference: '',
    });
    expect(r.ok).toBe(false);
  });

  it('returns cycle_not_found + emits probe', async () => {
    const { deps, emitMock } = fakeDeps(null);
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'renewal_cross_tenant_probe' }),
      expect.any(Object),
    );
  });

  it('returns cycle_not_payable for completed cycles', async () => {
    const { deps } = fakeDeps(buildCycle({ status: 'completed' }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('cycle_not_payable');
      if (r.error.kind === 'cycle_not_payable') {
        expect(r.error.currentStatus).toBe('completed');
      }
    }
  });

  it('returns cycle_not_payable for cancelled cycles', async () => {
    const { deps } = fakeDeps(buildCycle({ status: 'cancelled' }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_payable');
  });

  it('returns f4_failure for a TRANSIENT bridge fault (retry may help)', async () => {
    // Cluster 5 (Finding 2) — a non-permanent reason stays the generic
    // "please try again" f4_failure (stage + reason preserved for ops logs).
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => ({
      ok: false,
      error: { kind: 'issue_invoice_failed', reason: 'pdf_render_failed' },
    }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('f4_failure');
      if (r.error.kind === 'f4_failure') {
        expect(r.error.stage).toBe('issue_invoice_failed');
        expect(r.error.reason).toBe('pdf_render_failed');
      }
    }
  });

  // Cluster 5 (Finding 2) — a PERMANENT F4 reject (retry will NEVER succeed) is
  // now surfaced as a distinct, actionable code instead of the blanket
  // "please try again". `plan_not_found` is the imported-member case: the plan
  // for that fiscal year isn't in the fee catalogue yet.
  it('returns f4_permanent_failure for a permanent F4 reject (plan_not_found)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => ({
      ok: false,
      error: { kind: 'create_invoice_failed', reason: 'plan_not_found' },
    }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('f4_permanent_failure');
      if (r.error.kind === 'f4_permanent_failure') {
        expect(r.error.reason).toBe('plan_not_found');
      }
    }
  });

  it.each(['settings_missing', 'member_archived', 'member_not_found'] as const)(
    'returns f4_permanent_failure for permanent reject %s',
    async (reason) => {
      const cycle = buildCycle();
      const { deps } = fakeDeps(cycle, async () => ({
        ok: false,
        error: { kind: 'issue_invoice_failed', reason },
      }));
      const r = await markPaidOffline(deps, baseInput);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === 'f4_permanent_failure') {
        expect(r.error.reason).toBe(reason);
      } else {
        expect.unreachable('expected f4_permanent_failure');
      }
    },
  );

  it('returns f4_orphan_invoice when bridge reports record_payment_failed', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => ({
      ok: false,
      error: {
        kind: 'record_payment_failed',
        reason: 'concurrent_state_change',
        orphanInvoiceId: 'orphan-inv-99',
      },
    }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('f4_orphan_invoice');
      if (r.error.kind === 'f4_orphan_invoice') {
        expect(r.error.orphanInvoiceId).toBe('orphan-inv-99');
      }
    }
  });

  // Round 7 B-R6-5 — verify findByIdInTx receives the SAME tx handle
  // that acquireLockInTx received. cancel-cycle has the same test
  // (Round 6 W-R5-5); mark-paid-offline shares the TOCTOU pattern so
  // the B2 contract must be locked here too. Without this test, a
  // regression where mark-paid-offline reverts to non-tx findById
  // would silently re-introduce the TOCTOU window.
  it('post-lock re-read uses findByIdInTx with the lock-holding tx (B2)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle);
    await markPaidOffline(deps, baseInput);
    const acquireLockTx = (
      deps.cyclesRepo.acquireCycleLockInTx as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0];
    const findByIdInTxCalls = (
      deps.cyclesRepo.findByIdInTx as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(findByIdInTxCalls).toHaveLength(1);
    expect(findByIdInTxCalls[0]?.[0]).toBe(acquireLockTx);
  });

  // Round 6 S-R5-4 / Round 7 S-R6-2 — Bangkok fiscal-year boundary
  // partition. UTC 2026-12-31T17:00:00Z = 2027-01-01 00:00 BKK; UTC
  // 2026-12-31T16:59:59Z = 2026-12-31 23:59:59 BKK. Both partitions
  // pin the `>=` vs `>` boundary correctness so a regression to a
  // half-open interval is caught.
  it.each([
    { utcIso: '2026-12-31T17:00:00Z', expectedYear: 2027, label: 'BKK midnight' },
    { utcIso: '2026-12-31T16:59:59Z', expectedYear: 2026, label: 'one second before BKK midnight' },
  ])(
    'threads BKK fiscal year ($expectedYear) to F4 bridge at $label (S-04 / S-R6-2)',
    async ({ utcIso, expectedYear }) => {
      const cycle = buildCycle({
        periodFrom: utcIso,
        periodTo: '2027-12-31T17:00:00Z',
      });
      const { deps, bridgeMock } = fakeDeps(cycle);
      await markPaidOffline(deps, baseInput);
      expect(bridgeMock).toHaveBeenCalledWith(
        expect.objectContaining({ planYear: expectedYear }),
      );
    },
  );

  // Round 6 S-R5-5 — newExpiresAt source-of-truth. The Round 5 W-05 fix
  // re-derives newExpiresAt from `lockedCycle.periodTo` inside the tx.
  // Without this test, a future refactor that re-uses the pre-load
  // value (which could be stale if a concurrent path mutated period
  // anchors) would not be caught.
  it('derives newExpiresAt from lockedCycle.periodTo (NOT pre-lock snapshot) (W-05)', async () => {
    // Pre-load returns one periodTo, lock-protected re-read returns a
    // DIFFERENT periodTo simulating a concurrent anchor mutation. The
    // response + audit MUST use the locked value.
    const preLoadCycle = buildCycle({
      periodTo: '2027-06-01T00:00:00Z',
      frozenPlanTermMonths: 12,
    });
    const lockedCycle = buildCycle({
      periodTo: '2027-09-01T00:00:00Z', // 3 months later (concurrent shift)
      frozenPlanTermMonths: 12,
    });
    const { deps } = fakeDeps(preLoadCycle);
    // Override findByIdInTx to return the divergent locked cycle.
    // Round 7 S-R6-1 — `mockResolvedValueOnce` documents that this is
    // a single-invocation contract within the tx (use-case calls
    // findByIdInTx exactly once after acquiring the lock).
    (deps.cyclesRepo.findByIdInTx as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      lockedCycle,
    );
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 2027-09-01 + 12 months = 2028-09-01 (locked-source); preLoad
      // would have given 2028-06-01 if the regression returned.
      expect(r.value.newExpiresAt).toBe('2028-09-01T00:00:00.000Z');
    }
  });

  // Round 3 IM2 regression-detector — guards against a future F4 contract
  // change that decouples bridge.ok from onPaid invocation. Without this
  // safety net the cycle would commit as still-awaiting-payment while
  // F4 has already issued a paid invoice — exactly the inconsistency
  // Constitution Principle VIII forbids.
  it('returns server_error if F4 bridge returns ok WITHOUT firing onPaid (contract regression detector — K1-C7)', async () => {
    const cycle = buildCycle();
    // Bridge stub: returns ok but does NOT call input.onPaid — simulates
    // a future regression where F4 forgets to invoke the callback. The
    // use-case throws an Error inside the runInTenant tx (so the tx
    // rolls back) which the outer catch maps to server_error Result.
    const { deps } = fakeDeps(cycle, async () => ({
      ok: true,
      value: { invoiceId: 'inv-1', paidAt: '2026-05-15T10:00:00Z' },
    }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('server_error');
      if (r.error.kind === 'server_error') {
        // R4-W2 (staff-review-2026-05-09): use-case redacts raw
        // exception messages in the Result so route handlers can't
        // accidentally leak DB internals / contract violations via
        // toast / HTTP body. The "onPaid never fired" forensic detail
        // still lives in the logger.error call for SRE.
        expect(r.error.message).toBe('internal error — see server logs');
      }
    }
  });
});
