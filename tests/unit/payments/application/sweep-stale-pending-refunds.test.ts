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

  it("per-row error (W1) — one row's updateStatus throws; others continue in their own tx", async () => {
    // Each row gets its own withTx call so row A's aborted Postgres
    // tx does not corrupt row B's tx.
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
    // Per-row tx evidence — withTx invoked ≥ 3 times (1 read + 2
    // per-row write tx). One-tx-for-all would call withTx exactly once.
    expect(asMock(deps.paymentsRepo.withTx).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('concurrency guard (S5) — row finalised between read+write → zero rows matched → skipped', async () => {
    // Sweep passes `expectedCurrentStatus: 'pending'`. If a concurrent
    // writer (future webhook charge.refunded → real adapter) flipped
    // the row to `succeeded` between our read tx and the per-row
    // write tx, repo's UPDATE matches zero rows and throws → per-row
    // tx rolls back → audit doesn't commit → sweep skips the row.
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_raced' }),
    ]);
    asMock(deps.refundsRepo.updateStatus).mockImplementationOnce(async () => {
      throw new Error(
        'drizzle-refunds-repo: updateStatus matched zero rows for rfnd_raced',
      );
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }

    // Sweep MUST pass the concurrency guard so the repo can do the
    // status check.
    const updateCall = asMock(deps.refundsRepo.updateStatus).mock.calls[0]?.[1];
    expect(updateCall.expectedCurrentStatus).toBe('pending');
  });

  it('audit-emit failure (W2) — updateStatus is NOT called; row stays pending', async () => {
    // Audit emit runs BEFORE updateStatus inside the per-row tx; if
    // audit throws, updateStatus must not run (audit-before-mutation).
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_audit_fail' }),
    ]);
    asMock(deps.audit.emit).mockImplementationOnce(async () => {
      throw new Error('audit log offline');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    // No orphan failed row — updateStatus must never have been called.
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
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

  it('outer tx throw → sweep_failed with cause (constructor.name only — R3 H3-3)', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('sweep_failed');
      // R3 H3-3 (2026-04-28): cause is constructor.name only, never
      // raw `.message` — Postgres errors can carry SQL fragments /
      // column values per project log-redact contract.
      expect(r.error.cause).toBe('Error');
    }
  });

  it('outer tx throw — non-Error rejection → cause is "unknown" (R3 H3-3)', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw 'string-rejection';
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.cause).toBe('unknown');
  });
});
