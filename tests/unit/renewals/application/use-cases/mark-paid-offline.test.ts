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
  return {
    tenantId: TENANT_ID,
    cycleId: asCycleId(VALID_UUID),
    memberId: 'mem-1',
    status: 'awaiting_payment',
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

interface FakeDepsResult {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  bridgeMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
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
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
      transitionStatus: transitionMock,
      acquireCycleLockInTx: vi.fn(async () => {}),
    } as unknown as RenewalsDeps['cyclesRepo'],
    f4InvoiceBridge: {
      issueAndMarkPaid: bridgeMock,
    } as unknown as RenewalsDeps['f4InvoiceBridge'],
    auditEmitter: { emit: emitMock, emitInTx: emitInTxMock },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, emitInTxMock, bridgeMock, transitionMock };
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

  it('accepts upcoming + grace cycle states', async () => {
    for (const status of ['upcoming', 'awaiting_payment'] as const) {
      const { deps } = fakeDeps(buildCycle({ status }));
      const r = await markPaidOffline(deps, baseInput);
      expect(r.ok).toBe(true);
    }
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

  it('throws when bridge ok but onPaid did not fire (unreachable invariant)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle, async () => ({
      ok: true,
      value: { invoiceId: 'inv-1', paidAt: '2026-05-15T10:00:00Z' },
    }));
    await expect(markPaidOffline(deps, baseInput)).rejects.toThrow(
      /onPaid did not capture/,
    );
  });
});
