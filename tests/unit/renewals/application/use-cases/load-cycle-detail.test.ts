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
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const VALID_UUID = '00000000-0000-0000-0000-0000000000c3';
const TENANT_ID = 'tenantA';

const getInvoiceMock = vi.fn();
vi.mock('@/modules/invoicing', () => ({
  getInvoice: (...args: unknown[]) => getInvoiceMock(...args),
  makeGetInvoiceDeps: (_: string) => ({ invoiceRepo: {} }),
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(VALID_UUID),
    ...overrides,
  });
}

function fakeDeps(
  cycle: RenewalCycle | null,
  lapseAuditMock: ReturnType<typeof vi.fn> = vi.fn(async () => null),
): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  lapseAuditMock: ReturnType<typeof vi.fn>;
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
    reminderAuditQuery: {
      findReminderAuditsForCycle: vi.fn(async () => new Set()),
      findRenewalLapsedForCycle: lapseAuditMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, lapseAuditMock };
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

  it('hydrates linked invoice number from documentNumber.raw (legacy §87)', async () => {
    const cycle = buildCycle({
      linkedInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const { deps } = fakeDeps(cycle);
    // The REAL F4 `getInvoice` returns `documentNumber` as a `DocumentNumber`
    // value object (NOT a bare string) — the use-case must read `.raw`.
    const legacyDoc = DocumentNumber.of('INV', 2026, 1);
    if (!legacyDoc.ok) throw new Error('fixture doc number invalid');
    getInvoiceMock.mockResolvedValueOnce({
      ok: true,
      value: {
        documentNumber: legacyDoc.value,
        billDocumentNumberRaw: null,
        status: 'paid',
        total: { satang: 5000000n },
      },
    });
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.linkedInvoice) {
      expect(r.value.linkedInvoice.invoiceNumber).toBe('INV-2026-000001');
      expect(r.value.linkedInvoice.totalSatang).toBe(5000000n);
    }
  });

  it('088 T069 — hydrates the SC bill number when documentNumber is NULL (ใบแจ้งหนี้)', async () => {
    const cycle = buildCycle({
      linkedInvoiceId: '11111111-1111-1111-1111-111111111111',
    });
    const { deps } = fakeDeps(cycle);
    // A renewal-generated 088 ใบแจ้งหนี้: NULL `documentNumber`, non-§87 `SC`
    // bill number in `billDocumentNumberRaw`. The cycle-detail surface must
    // show the SC number, never blank (FR-018).
    getInvoiceMock.mockResolvedValueOnce({
      ok: true,
      value: {
        documentNumber: null,
        billDocumentNumberRaw: 'SC-2026-000123',
        status: 'issued',
        total: { satang: 1284000n },
      },
    });
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.linkedInvoice) {
      expect(r.value.linkedInvoice.invoiceNumber).toBe('SC-2026-000123');
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

  // 066 S3 — termination-basis surfacing.
  it('populates lapseInfo from the renewal_lapsed audit for a lapsed cycle', async () => {
    const cycle = buildCycle({ status: 'lapsed', closedReason: 'grace_expired' });
    const lapseAuditMock = vi.fn(async () => ({
      terminationBasis: 'due_plus_60' as const,
      dueDate: '2026-01-15',
    }));
    const { deps } = fakeDeps(cycle, lapseAuditMock);
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(lapseAuditMock).toHaveBeenCalledWith(TENANT_ID, VALID_UUID);
      expect(r.value.lapseInfo).toEqual({
        terminationBasis: 'due_plus_60',
        dueDate: '2026-01-15',
      });
    }
  });

  it('leaves lapseInfo null and skips the audit read for a non-lapsed cycle', async () => {
    // Default buildCycle status is 'awaiting_payment' (a live, non-terminal cycle).
    const cycle = buildCycle();
    const lapseAuditMock = vi.fn(async () => ({
      terminationBasis: 'due_plus_60' as const,
      dueDate: '2026-01-15',
    }));
    const { deps } = fakeDeps(cycle, lapseAuditMock);
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(lapseAuditMock).not.toHaveBeenCalled();
      expect(r.value.lapseInfo).toBeNull();
    }
  });

  it('degrades lapseInfo to null when the audit read throws', async () => {
    const cycle = buildCycle({ status: 'lapsed', closedReason: 'grace_expired' });
    const lapseAuditMock = vi.fn(async () => {
      throw new Error('db blip');
    });
    const { deps } = fakeDeps(cycle, lapseAuditMock);
    const r = await loadCycleDetail(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lapseInfo).toBeNull();
    }
  });
});
