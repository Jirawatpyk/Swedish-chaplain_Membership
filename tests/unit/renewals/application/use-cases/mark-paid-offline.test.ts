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
}

function fakeDeps(
  cycle: RenewalCycle | null,
  bridgeImpl?: (input: {
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
    }) => Promise<void>;
  }) => Promise<unknown>,
): FakeDepsResult {
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(async () => {});
  const transitionMock = vi.fn(async () => ({ ...cycle!, status: 'completed' }));
  const defaultBridge = async (input: {
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
    };
    if (input.onPaid) await input.onPaid(evt);
    return { ok: true, value: { invoiceId: 'inv-1', paidAt: evt.paidAt } };
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
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
      findByIdInTx: vi.fn(async () => cycle),
      transitionStatus: transitionMock,
      acquireCycleLockInTx: vi.fn(async () => {}),
      findByInvoiceIdInTx: findByInvoiceIdInTxMock,
      findActiveForMemberInTx: findActiveForMemberInTxMock,
      insert: insertMock,
    } as unknown as RenewalsDeps['cyclesRepo'],
    f4InvoiceBridge: {
      issueAndMarkPaid: bridgeMock,
    } as unknown as RenewalsDeps['f4InvoiceBridge'],
    auditEmitter: { emit: emitMock, emitInTx: emitInTxMock },
    planLookupForRenewal: {
      loadPlanFrozenFields: loadPlanFrozenFieldsMock,
    } as unknown as RenewalsDeps['planLookupForRenewal'],
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
      expect(r.value.cycleStatus).toBe('completed');
      expect(r.value.invoiceId).toBe('inv-1');
      expect(r.value.newExpiresAt).toBe('2028-06-01T00:00:00.000Z');
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

  it('returns f4_failure when bridge fails', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => ({
      ok: false,
      error: { kind: 'create_invoice_failed', reason: 'plan_not_found' },
    }));
    const r = await markPaidOffline(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('f4_failure');
      if (r.error.kind === 'f4_failure') {
        expect(r.error.stage).toBe('create_invoice_failed');
        expect(r.error.reason).toBe('plan_not_found');
      }
    }
  });

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
