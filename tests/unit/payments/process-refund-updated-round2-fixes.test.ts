/**
 * Round-2 review fixes for `processRefundUpdated` (PR #185):
 *
 *   #32 — a failed amount projection writes the `'projection_failed'` sentinel
 *         into the 10y OOB / auto-refund-failed forensics, never a wrong `0`.
 *   #33 — the `auto_refund_failed_needs_manual_reconcile` PAGING metric is
 *         single-owner on `refund.updated` (suppressed on the deprecated
 *         `charge.refund.updated`) so a charged auto-refund failure delivered
 *         via BOTH events pages ONCE. The 10y forensic stays redundant.
 *   #34 — the charge-less OOB paging metric fires only on the TERMINAL
 *         transition, so a pending→succeeded refund.updated pair pages ONCE.
 *
 * PCI SAQ-A: minimal mocks; no card metadata anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  processRefundUpdated,
  type ProcessRefundUpdatedDeps,
  type ProcessRefundUpdatedInput,
} from '@/modules/payments/application/use-cases/process-refund-updated';
import { paymentsMetrics } from '@/lib/metrics';

const TENANT_ID = 'tnt_round2';
const RE = 're_round2';
const CH = 'ch_round2';

vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: {
      ...actual.paymentsMetrics,
      outOfBandRefundRejected: vi.fn(),
      autoRefundFailedNeedsReconcile: vi.fn(),
    },
  };
});

const clock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
};

describe('processRefundUpdated — Round-2 fixes', () => {
  let auditEmit: ReturnType<typeof vi.fn>;
  let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.mocked(paymentsMetrics.outOfBandRefundRejected).mockClear();
    vi.mocked(paymentsMetrics.autoRefundFailedNeedsReconcile).mockClear();
    auditEmit = vi.fn(async () => undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function makeDeps(opts: {
    autoRefund?: { paymentId: string; invoiceId: string } | null;
  }): ProcessRefundUpdatedDeps {
    return {
      paymentsRepo: {
        withTx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ __mock: 'tx' })),
        findAutoRefundByProcessorRefundId: vi.fn(async () => opts.autoRefund ?? null),
      } as unknown as ProcessRefundUpdatedDeps['paymentsRepo'],
      refundsRepo: {
        // No in-app refund row → OOB / auto-refund-marker branch.
        lockForUpdateByProcessorRefundId: vi.fn(async () => null),
      } as unknown as ProcessRefundUpdatedDeps['refundsRepo'],
      processorEventsRepo: {
        markProcessed: vi.fn(async () => undefined),
      } as unknown as ProcessRefundUpdatedDeps['processorEventsRepo'],
      invoicingBridge: {
        issueCreditNoteFromRefund: vi.fn(),
      } as unknown as ProcessRefundUpdatedDeps['invoicingBridge'],
      audit: { emit: auditEmit } as unknown as ProcessRefundUpdatedDeps['audit'],
      clock,
      logger,
    };
  }

  function input(over: Partial<ProcessRefundUpdatedInput>): ProcessRefundUpdatedInput {
    return {
      tenantId: TENANT_ID,
      requestId: 'req-round2',
      eventId: 'evt_round2',
      processorRefundId: RE,
      chargeId: null,
      refundStatus: 'succeeded',
      amountSatang: asSatang(50_000n),
      processorEnv: 'test',
      ...over,
    };
  }

  function auditPayload(eventType: string): Record<string, unknown> | undefined {
    const call = auditEmit.mock.calls.find(
      (c) => (c[1] as { eventType: string }).eventType === eventType,
    );
    return call?.[1].payload as Record<string, unknown> | undefined;
  }

  // ---- #34: charge-less OOB metric fires once, on the terminal transition ----

  it('#34 — charge-less OOB, refund.updated(pending) → does NOT page (not terminal)', async () => {
    const res = await processRefundUpdated(makeDeps({}), input({ refundStatus: 'pending' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.kind).toBe('out_of_band');
    // Forensic still recorded on the pending delivery (redundant, deduped on read).
    expect(auditPayload('out_of_band_refund_detected')).toBeDefined();
    // But NO page — the succeeded delivery owns the single page.
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).not.toHaveBeenCalled();
  });

  it('#34 — charge-less OOB, refund.updated(succeeded) → pages exactly once', async () => {
    await processRefundUpdated(makeDeps({}), input({ refundStatus: 'succeeded' }));
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
  });

  it('#34 — charge-less OOB, refund.updated(failed) → still pages once (failure is terminal)', async () => {
    await processRefundUpdated(makeDeps({}), input({ refundStatus: 'failed' }));
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
  });

  // ---- #33: auto-refund-failed paging metric single-owner on refund.updated ----

  it('#33 — auto-refund failed via charge.refund.updated (deprecated) → forensic emitted but NO page', async () => {
    const deps = makeDeps({ autoRefund: { paymentId: 'pmt_x', invoiceId: 'inv_x' } });
    const res = await processRefundUpdated(
      deps,
      input({ refundStatus: 'failed', chargeId: CH, sourceEventType: 'charge.refund.updated' }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.kind).toBe('auto_refund_failed');
    // Forensic IS written (redundant / SPOF-safe).
    expect(auditPayload('auto_refund_failed_needs_manual_reconcile')).toBeDefined();
    // Deprecated event does NOT page — refund.updated owns it.
    expect(vi.mocked(paymentsMetrics.autoRefundFailedNeedsReconcile)).not.toHaveBeenCalled();
  });

  it('#33 — auto-refund failed via refund.updated (forward path) → pages once', async () => {
    const deps = makeDeps({ autoRefund: { paymentId: 'pmt_x', invoiceId: 'inv_x' } });
    await processRefundUpdated(
      deps,
      input({ refundStatus: 'failed', chargeId: CH, sourceEventType: 'refund.updated' }),
    );
    expect(vi.mocked(paymentsMetrics.autoRefundFailedNeedsReconcile)).toHaveBeenCalledTimes(1);
  });

  it('#33 — legacy caller omitting sourceEventType still pages (guard suppresses only the explicit deprecated event)', async () => {
    const deps = makeDeps({ autoRefund: { paymentId: 'pmt_x', invoiceId: 'inv_x' } });
    await processRefundUpdated(deps, input({ refundStatus: 'failed', chargeId: CH }));
    expect(vi.mocked(paymentsMetrics.autoRefundFailedNeedsReconcile)).toHaveBeenCalledTimes(1);
  });

  // ---- #32: projection-failed sentinel in the 10y forensics ----

  it('#32 — amountProjectionFailed → OOB forensic writes the projection_failed sentinel, not a wrong 0', async () => {
    await processRefundUpdated(
      makeDeps({}),
      input({ refundStatus: 'succeeded', amountProjectionFailed: true, amountSatang: asSatang(0n) }),
    );
    expect(auditPayload('out_of_band_refund_detected')?.amount_satang).toBe('projection_failed');
  });

  it('#32 — amountProjectionFailed → auto-refund-failed forensic writes the projection_failed sentinel', async () => {
    const deps = makeDeps({ autoRefund: { paymentId: 'pmt_x', invoiceId: 'inv_x' } });
    await processRefundUpdated(
      deps,
      input({
        refundStatus: 'failed',
        chargeId: CH,
        amountProjectionFailed: true,
        amountSatang: asSatang(0n),
      }),
    );
    expect(auditPayload('auto_refund_failed_needs_manual_reconcile')?.amount_satang).toBe(
      'projection_failed',
    );
  });

  it('#32 — normal amount (no projection failure) writes the numeric satang string', async () => {
    await processRefundUpdated(
      makeDeps({}),
      input({ refundStatus: 'succeeded', amountSatang: asSatang(50_000n) }),
    );
    expect(auditPayload('out_of_band_refund_detected')?.amount_satang).toBe('50000');
  });
});
