/**
 * T130a — sweepStalePendingRefunds use-case unit tests.
 *
 * Coverage policy: 100% branch (security-critical recovery path).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepStalePendingRefunds } from '@/modules/payments';
import type {
  SweepStalePendingRefundsDeps,
  SweepStalePendingRefundsInput,
} from '@/modules/payments';
import { asPaymentId } from '@/modules/payments/domain/payment';

const TENANT_ID = 'tnt-1';
const NOW_MS = Date.parse('2026-04-27T10:00:00.000Z');
const PAYMENT_ID = asPaymentId('pmt_01JABCDEFGHJKMNPQRSTVWXYZ');

function makeStaleRow(overrides: { id?: string; ageHours?: number } = {}) {
  const ageMs = (overrides.ageHours ?? 30) * 60 * 60 * 1000;
  return {
    id: overrides.id ?? 'rfnd_01STALE',
    paymentId: PAYMENT_ID,
    invoiceId: 'inv-1',
    amountSatang: 350_000n,
    initiatedAt: new Date(NOW_MS - ageMs),
    correlationId: 'corr-stale',
    initiatorUserId: 'user-admin-1',
  };
}

function makeDeps(): SweepStalePendingRefundsDeps {
  const tx = Symbol('tx');
  return {
    paymentsRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)) as unknown as SweepStalePendingRefundsDeps['paymentsRepo']['withTx'],
    },
    refundsRepo: {
      insert: vi.fn(),
      updateStatus: vi.fn(async () => ({
        id: 'rfnd_01STALE',
        tenantId: TENANT_ID,
        paymentId: PAYMENT_ID,
        invoiceId: 'inv-1',
        amountSatang: 350_000n,
        status: 'failed' as const,
        processorRefundId: null,
      })),
      findByProcessorRefundId: vi.fn(),
      getRefundContextForUpdate: vi.fn(),
      listPendingOlderThan: vi.fn(async () => [makeStaleRow()]),
    } as unknown as SweepStalePendingRefundsDeps['refundsRepo'],
    audit: { emit: vi.fn(async () => undefined) },
    clock: { nowIso: () => new Date(NOW_MS).toISOString(), nowMs: () => NOW_MS },
  };
}

function asMock<T>(fn: T): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

const baseInput: SweepStalePendingRefundsInput = {
  tenantId: TENANT_ID,
  requestId: 'req-sweep-1',
};

describe('sweepStalePendingRefunds (T130a)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — single stale row → updateStatus failed + audit + count=1', async () => {
    const deps = makeDeps();
    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(1);
      expect(r.value.skippedCount).toBe(0);
      expect(r.value.cutoff).toBe(
        new Date(NOW_MS - 24 * 60 * 60 * 1000).toISOString(),
      );
    }

    const updateCall = asMock(deps.refundsRepo.updateStatus).mock.calls[0]?.[1];
    expect(updateCall).toMatchObject({
      nextStatus: 'failed',
      failureReasonCode: 'stale_pending_sweep',
    });

    const auditCall = asMock(deps.audit.emit).mock.calls[0]?.[1];
    expect(auditCall.eventType).toBe('stale_pending_refund_detected');
    expect(auditCall.retentionYears).toBe(10);
    expect(auditCall.actorUserId).toBe('system:stale-pending-refund-sweep');
    expect(auditCall.payload.runbook_url).toMatch(/stale-pending-refund-sweep\.md/);
    expect(auditCall.payload.age_minutes).toBe(30 * 60); // 30h × 60
  });

  it('empty result — no stale rows → swept=0, no audit emit', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([]);

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sweptCount).toBe(0);
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('multi-row — 3 stale rows all swept; cutoff respected via olderThanHours override', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_a', ageHours: 25 }),
      makeStaleRow({ id: 'rfnd_b', ageHours: 26 }),
      makeStaleRow({ id: 'rfnd_c', ageHours: 27 }),
    ]);

    const r = await sweepStalePendingRefunds(deps, {
      ...baseInput,
      olderThanHours: 12,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(3);
      expect(r.value.cutoff).toBe(
        new Date(NOW_MS - 12 * 60 * 60 * 1000).toISOString(),
      );
    }
    expect(asMock(deps.audit.emit)).toHaveBeenCalledTimes(3);
  });

  it("per-row error — one row's updateStatus throws; others continue; skipped count", async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_a' }),
      makeStaleRow({ id: 'rfnd_b' }),
    ]);
    asMock(deps.refundsRepo.updateStatus).mockImplementationOnce(async () => {
      throw new Error('row a update failed');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(1);
      expect(r.value.skippedCount).toBe(1);
    }
  });

  it('invalid olderThanHours (≤ 0) → sweep_failed', async () => {
    const deps = makeDeps();
    const r = await sweepStalePendingRefunds(deps, {
      ...baseInput,
      olderThanHours: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('sweep_failed');
      expect(r.error.cause).toMatch(/olderThanHours/);
    }
    expect(asMock(deps.refundsRepo.listPendingOlderThan)).not.toHaveBeenCalled();
  });

  it('outer tx throw → sweep_failed with cause', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('sweep_failed');
      expect(r.error.cause).toBe('connection lost');
    }
  });

  it('outer tx throw — non-Error rejection → cause stringified', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw 'string-rejection';
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.cause).toBe('string-rejection');
  });
});
