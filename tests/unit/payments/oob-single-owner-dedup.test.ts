/**
 * Findings 2 + 4 — out-of-band refund single-owner dedup (cross-handler).
 *
 * Stripe delivers BOTH `charge.refunded` AND `charge.refund.updated` for the
 * same genuine Dashboard-initiated (out-of-band) refund. This test pins the
 * combined invariant that survives both fixes:
 *
 *   - `processChargeRefunded` (charge.refunded) is the SOLE OOB detector —
 *     it emits `out_of_band_refund_detected` + bumps `outOfBandRefundRejected`
 *     (Finding 2 only SUPPRESSES app-initiated auto-refunds, never a genuine
 *     Dashboard OOB).
 *   - `processRefundUpdated` (charge.refund.updated) DEFERS — on a genuine OOB
 *     it logs + acks only, emitting NO audit + NO metric (Finding 4).
 *
 * Net across both webhook deliveries: exactly ONE forensic audit + ONE paging
 * metric per refund — regardless of delivery order. Both handlers share the
 * same `audit.emit` spy + metric mock here so the assertion sums across them.
 *
 * PCI SAQ-A: minimal mocks; no card metadata anywhere in the deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  processChargeRefunded,
  type ProcessChargeRefundedDeps,
} from '@/modules/payments/application/use-cases/process-charge-refunded';
import {
  processRefundUpdated,
  type ProcessRefundUpdatedDeps,
} from '@/modules/payments/application/use-cases/process-refund-updated';
import { paymentsMetrics } from '@/lib/metrics';

const TENANT_ID = 'tnt_oob_single_owner';
const RE_OOB = 're_genuine_dashboard_oob';
const CH_OOB = 'ch_oob';

vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: {
      ...actual.paymentsMetrics,
      outOfBandRefundRejected: vi.fn(),
    },
  };
});

describe('OOB single-owner dedup — genuine Dashboard refund → exactly ONE audit + ONE metric across both handlers (Findings 2 + 4)', () => {
  // Shared spies so the assertion sums across BOTH webhook handlers.
  let auditEmit: ReturnType<typeof vi.fn>;
  const clock = {
    nowMs: () => 1_700_000_000_000,
    nowIso: () => '2023-11-14T22:13:20.000Z',
  };
  let logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.mocked(paymentsMetrics.outOfBandRefundRejected).mockClear();
    auditEmit = vi.fn(async () => undefined);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  function chargeRefundedDeps(): ProcessChargeRefundedDeps {
    return {
      paymentsRepo: {
        withTx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ __mock: 'tx' })),
        // genuine OOB: no durable app-initiated auto-refund marker.
        findAutoRefundByProcessorRefundId: vi.fn(async () => null),
      } as unknown as ProcessChargeRefundedDeps['paymentsRepo'],
      refundsRepo: {
        // genuine OOB: no in-app refunds row.
        findByProcessorRefundId: vi.fn(async () => null),
      } as unknown as ProcessChargeRefundedDeps['refundsRepo'],
      processorEventsRepo: {
        markProcessed: vi.fn(async () => undefined),
      } as unknown as ProcessChargeRefundedDeps['processorEventsRepo'],
      audit: { emit: auditEmit } as unknown as ProcessChargeRefundedDeps['audit'],
      clock,
      logger,
    };
  }

  function refundUpdatedDeps(): ProcessRefundUpdatedDeps {
    return {
      paymentsRepo: {
        withTx: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb({ __mock: 'tx' })),
        findAutoRefundByProcessorRefundId: vi.fn(async () => null),
      } as unknown as ProcessRefundUpdatedDeps['paymentsRepo'],
      refundsRepo: {
        // genuine OOB: no in-app refund row under lock either.
        lockForUpdateByProcessorRefundId: vi.fn(async () => null),
      } as unknown as ProcessRefundUpdatedDeps['refundsRepo'],
      processorEventsRepo: {
        markProcessed: vi.fn(async () => undefined),
      } as unknown as ProcessRefundUpdatedDeps['processorEventsRepo'],
      invoicingBridge: {
        // never reached on the OOB path — a call here would be a bug.
        issueCreditNoteFromRefund: vi.fn(),
      } as unknown as ProcessRefundUpdatedDeps['invoicingBridge'],
      audit: { emit: auditEmit } as unknown as ProcessRefundUpdatedDeps['audit'],
      clock,
      logger,
    };
  }

  async function runChargeRefunded() {
    return processChargeRefunded(chargeRefundedDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-oob',
      eventId: 'evt_charge_refunded',
      chargeId: CH_OOB,
      refundIds: [RE_OOB],
      amountSatang: 50_000n,
      processorEnv: 'test',
    });
  }

  async function runRefundUpdated() {
    return processRefundUpdated(refundUpdatedDeps(), {
      tenantId: TENANT_ID,
      requestId: 'req-oob',
      eventId: 'evt_refund_updated',
      processorRefundId: RE_OOB,
      chargeId: CH_OOB,
      refundStatus: 'succeeded',
      amountSatang: asSatang(50_000n),
      processorEnv: 'test',
    });
  }

  function oobAuditCount(): number {
    return auditEmit.mock.calls.filter(
      (c) => (c[1] as { eventType: string }).eventType === 'out_of_band_refund_detected',
    ).length;
  }

  it('charge.refunded first (owner emits), charge.refund.updated second (defers) → exactly ONE audit + ONE metric', async () => {
    const chargeRes = await runChargeRefunded();
    expect(chargeRes.ok).toBe(true);

    const updatedRes = await runRefundUpdated();
    expect(updatedRes.ok).toBe(true);
    if (updatedRes.ok) expect(updatedRes.value.kind).toBe('out_of_band');

    expect(oobAuditCount()).toBe(1);
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
  });

  it('reversed order (charge.refund.updated first, charge.refunded second) → still exactly ONE audit + ONE metric', async () => {
    const updatedRes = await runRefundUpdated();
    expect(updatedRes.ok).toBe(true);

    const chargeRes = await runChargeRefunded();
    expect(chargeRes.ok).toBe(true);

    expect(oobAuditCount()).toBe(1);
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
  });
});
