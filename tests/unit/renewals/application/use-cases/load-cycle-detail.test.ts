/**
 * F8 Phase 3 Wave H2 · T057 spec — `loadCycleDetail` use-case.
 *
 * Mocks the F4 `getInvoice` barrel via vi.mock. Verifies cross-tenant
 * probe emit + linked-invoice hydration paths.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { loadCycleDetail } from '@/modules/renewals/application/use-cases/load-cycle-detail';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c3';
const TENANT_ID = 'tenantA';

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: (_: string) => ({ invoiceRepo: {} }),
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

function fakeDeps(cycle: RenewalCycle | null): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const emitMock = vi.fn(async () => {});
  const deps: RenewalsDeps = {
    cyclesRepo: {
      findById: vi.fn(async () => cycle),
    } as unknown as RenewalsDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: vi.fn(),
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: VALID_UUID,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('loadCycleDetail (T057)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns cycle + empty placeholder lists for Phase 3', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps(cycle);
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cycle).toEqual(cycle);
      expect(r.value.reminderHistory).toEqual([]);
      expect(r.value.escalationTasks).toEqual([]);
      expect(r.value.linkedInvoice).toBeNull();
    }
  });

  it('hydrates linked invoice when linkedInvoiceId set', async () => {
    const cycle = buildCycle({
      linkedInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const { deps } = fakeDeps(cycle);
    getInvoiceMock.mockResolvedValueOnce({
      ok: true,
      value: {
        documentNumber: 'INV-2026-0001',
        status: 'paid',
        total: { satang: 5000000n },
      },
    });
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.linkedInvoice) {
      expect(r.value.linkedInvoice.invoiceNumber).toBe('INV-2026-0001');
      expect(r.value.linkedInvoice.totalSatang).toBe(5000000n);
    }
  });

  it('falls back to stub linkedInvoice on F4 error', async () => {
    const cycle = buildCycle({
      linkedInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const { deps } = fakeDeps(cycle);
    getInvoiceMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'not_found' },
    });
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.linkedInvoice) {
      expect(r.value.linkedInvoice.invoiceNumber).toBeNull();
      expect(r.value.linkedInvoice.status).toBe('unknown');
    }
  });

  it('returns cycle_not_found + emits probe', async () => {
    const { deps, emitMock } = fakeDeps(null);
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'renewal_cross_tenant_probe' }),
      expect.any(Object),
    );
  });

  it('returns invalid_input on bad cycleId', async () => {
    const { deps } = fakeDeps(buildCycle());
    const r = await loadCycleDetail(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
