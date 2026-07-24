/**
 * Money-remediation Task 9 (F-9) — app-initiated refund recognition, both
 * webhook handlers.
 *
 * THE DEFECT UNDER TEST. `issueRefund` writes `processor_refund_id` in a
 * SEPARATE tx after Stripe returns. A `charge.refunded` / `refund.updated`
 * delivery landing inside that window finds no row and fires
 * `out_of_band_refund_detected` — a 10-year forensic claiming money left by an
 * unauthorised route, plus an on-call page — for a refund we initiated.
 *
 * TEST SHAPE IS DELIBERATE AND NOT NEGOTIABLE.
 *
 * 1. Every suppression assertion is a CONJUNCTION: absence of the OOB audit AND
 *    the positive `attachProcessorRefundId` call carrying the exact `re_…` id.
 *    Absence alone is satisfied by a stub that silently returns null, which is
 *    a vacuous test — this repo has shipped that shape before.
 *
 * 2. There is a POSITIVE CONTROL against over-correction. Over-suppression is
 *    the dangerous direction here: the OOB alert exists to catch money leaving
 *    by an unauthorised route, and a loose fallback lets someone with Stripe
 *    Dashboard access — the exact actor being watched — mute their own alarm. A
 *    suite that only proves suppression works is how a too-loose fix ships. The
 *    control asserts a markerless refund STILL produces exactly one forensic
 *    and one metric, and it must go RED if the fallback is made unconditional.
 *
 * 3. The forged-marker cases (cross-tenant, PI mismatch) assert the forensic is
 *    STILL EMITTED. Those are the cases a malicious actor actually produces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  processChargeRefunded,
  type ProcessChargeRefundedDeps,
  type ProcessChargeRefundedInput,
} from '@/modules/payments/application/use-cases/process-charge-refunded';
import {
  processRefundUpdated,
  type ProcessRefundUpdatedDeps,
  type ProcessRefundUpdatedInput,
} from '@/modules/payments/application/use-cases/process-refund-updated';
import { asPaymentId } from '@/modules/payments/domain/payment';
import { paymentsMetrics } from '@/lib/metrics';

const TENANT_ID = 'tnt_f9_recognition';
const OTHER_TENANT_ID = 'tnt_f9_attacker';
const APP_REFUND_ID = 'rfnd_0123456789abcdef0123456789abcdef';
const PROCESSOR_REFUND_ID = 're_f9_from_stripe';
const PAYMENT_INTENT_ID = 'pi_f9_parent';
const INVOICE_ID = 'inv-f9-0001';

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

/**
 * The row `findAwaitingAttachByAppRefundId` returns for a genuine app-initiated
 * refund still awaiting its Stripe id.
 */
function awaitingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_REFUND_ID,
    paymentId: asPaymentId('pmt_01hyyyyyyyyyyyyyyyyyyyyyyy'),
    invoiceId: INVOICE_ID,
    amountSatang: asSatang(100_000n),
    status: 'pending' as const,
    parentProcessorPaymentIntentId: PAYMENT_INTENT_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

function makeChargeDeps(
  awaiting: ReturnType<typeof awaitingRow> | null,
): ProcessChargeRefundedDeps {
  return {
    paymentsRepo: {
      withTx: vi.fn(async (cb) => cb({ __mock: 'tx' })),
      findAutoRefundByProcessorRefundId: vi.fn(async () => null),
    } as unknown as ProcessChargeRefundedDeps['paymentsRepo'],
    refundsRepo: {
      findByProcessorRefundId: vi.fn(async () => null),
      findAwaitingAttachByAppRefundId: vi.fn(async () => awaiting),
      attachProcessorRefundId: vi.fn(async () => undefined),
    } as unknown as ProcessChargeRefundedDeps['refundsRepo'],
    processorEventsRepo: {
      markProcessed: vi.fn(async () => undefined),
    } as unknown as ProcessChargeRefundedDeps['processorEventsRepo'],
    audit: {
      emit: vi.fn(async () => undefined),
    } as unknown as ProcessChargeRefundedDeps['audit'],
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2023-11-14T22:13:20.000Z',
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function chargeInput(
  partial: Partial<ProcessChargeRefundedInput> = {},
): ProcessChargeRefundedInput {
  return {
    tenantId: TENANT_ID,
    requestId: 'req-f9',
    eventId: 'evt_f9_charge',
    chargeId: 'ch_f9',
    refundIds: [PROCESSOR_REFUND_ID],
    amountSatang: asSatang(100_000n),
    processorEnv: 'test',
    ...partial,
  };
}

function oobEmits(audit: ProcessChargeRefundedDeps['audit']) {
  return vi
    .mocked(audit.emit)
    .mock.calls.filter(
      (c) =>
        (c[1] as { eventType?: string }).eventType ===
        'out_of_band_refund_detected',
    );
}

describe('F-9 charge.refunded — recognition suppresses the false forensic', () => {
  beforeEach(() => {
    vi.mocked(paymentsMetrics.outOfBandRefundRejected).mockClear();
  });

  it('CONJUNCTION: no OOB audit AND attaches the exact re_ id', async () => {
    const deps = makeChargeDeps(awaitingRow());

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);

    // Half 1 — the false forensic did not fire, and neither did the page.
    expect(oobEmits(deps.audit)).toHaveLength(0);
    expect(paymentsMetrics.outOfBandRefundRejected).not.toHaveBeenCalled();

    // Half 2 — the POSITIVE effect. Without this, a stub silently returning
    // null would satisfy half 1 and the test would prove nothing.
    expect(deps.refundsRepo.attachProcessorRefundId).toHaveBeenCalledTimes(1);
    expect(deps.refundsRepo.attachProcessorRefundId).toHaveBeenCalledWith(
      expect.anything(),
      {
        refundId: APP_REFUND_ID,
        tenantId: TENANT_ID,
        processorRefundId: PROCESSOR_REFUND_ID,
      },
    );

    // It repaired the row; it did NOT finalise it. Settlement ownership stays
    // with charge.refund.updated / refund.updated (A.11/A.12).
    expect(
      (deps.refundsRepo as unknown as { updateStatus?: unknown }).updateStatus,
    ).toBeUndefined();
  });

  it('surfaces the recovered invoiceId for surgical revalidation', async () => {
    const deps = makeChargeDeps(awaitingRow());

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok && result.value.invoiceId).toBe(INVOICE_ID);
  });

  /**
   * THE POSITIVE CONTROL. Must go RED if the fallback is made unconditional.
   * A suite that only proves suppression works is exactly how an
   * alarm-suppression primitive ships.
   */
  it('CONTROL: a markerless refund still emits exactly one forensic + one metric', async () => {
    const deps = makeChargeDeps(awaitingRow());

    const result = await processChargeRefunded(deps, chargeInput());

    expect(result.ok).toBe(true);
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(paymentsMetrics.outOfBandRefundRejected).toHaveBeenCalledTimes(1);
    // The marker path was never consulted — no marker, no lookup.
    expect(
      deps.refundsRepo.findAwaitingAttachByAppRefundId,
    ).not.toHaveBeenCalled();
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
  });

  /**
   * Principle I, Review-Gate blocker. A forged marker naming another tenant's
   * row resolves to null (repo tenant filter + RLS) and MUST still be reported.
   */
  it('cross-tenant forged marker: no match AND the forensic still fires', async () => {
    // The repo refuses to resolve it — exactly what live Neon does.
    const deps = makeChargeDeps(null);

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        tenantId: OTHER_TENANT_ID,
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(paymentsMetrics.outOfBandRefundRejected).toHaveBeenCalledTimes(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
    // The lookup was scoped to the CALLER's tenant, never the marker's owner.
    expect(
      deps.refundsRepo.findAwaitingAttachByAppRefundId,
    ).toHaveBeenCalledWith(expect.anything(), OTHER_TENANT_ID, APP_REFUND_ID);
  });

  /**
   * The case a malicious actor actually produces: a well-formed marker naming a
   * real row, on a refund against a DIFFERENT PaymentIntent. Not a benign miss.
   */
  it('PI mismatch: forged marker does NOT suppress the forensic', async () => {
    const deps = makeChargeDeps(
      awaitingRow({ parentProcessorPaymentIntentId: 'pi_someone_elses' }),
    );

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(paymentsMetrics.outOfBandRefundRejected).toHaveBeenCalledTimes(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
    expect(deps.logger?.warn).toHaveBeenCalledWith(
      'refund_marker_payment_intent_mismatch',
      expect.objectContaining({ refundId: APP_REFUND_ID }),
    );
  });

  it('unknown event PI: an unsatisfiable cross-check does NOT suppress', async () => {
    const deps = makeChargeDeps(awaitingRow());

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: null,
      }),
    );

    expect(result.ok).toBe(true);
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
  });

  /**
   * A terminal row with a NULL processor id was finalised under a rejection
   * proof — Stripe said the money never moved. A settlement webhook naming it
   * is a genuine contradiction and must keep its forensic.
   */
  it('terminal row: contradicts its own rejection proof, keeps the forensic', async () => {
    const deps = makeChargeDeps(awaitingRow({ status: 'failed' }));

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
    expect(deps.logger?.warn).toHaveBeenCalledWith(
      'refund_marker_matched_terminal_row',
      expect.objectContaining({ rowStatus: 'failed' }),
    );
  });

  it('mixed charge: suppresses the app refund, reports its Dashboard sibling', async () => {
    const deps = makeChargeDeps(awaitingRow());
    const dashboardRefundId = 're_f9_dashboard';

    const result = await processChargeRefunded(
      deps,
      chargeInput({
        refundIds: [PROCESSOR_REFUND_ID, dashboardRefundId],
        appRefundIds: { [PROCESSOR_REFUND_ID]: APP_REFUND_ID },
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);
    // Exactly ONE forensic — for the sibling, not for ours.
    const emits = oobEmits(deps.audit);
    expect(emits).toHaveLength(1);
    expect(
      (emits[0]?.[1] as { payload: { processor_refund_id: string } }).payload
        .processor_refund_id,
    ).toBe(dashboardRefundId);
    expect(deps.refundsRepo.attachProcessorRefundId).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// refund.updated / charge.refund.updated
// ---------------------------------------------------------------------------

function makeRefundUpdatedDeps(
  awaiting: ReturnType<typeof awaitingRow> | null,
): ProcessRefundUpdatedDeps {
  return {
    paymentsRepo: {
      withTx: vi.fn(async (cb) => cb({ __mock: 'tx' })),
      findAutoRefundByProcessorRefundId: vi.fn(async () => null),
    } as unknown as ProcessRefundUpdatedDeps['paymentsRepo'],
    refundsRepo: {
      lockForUpdateByProcessorRefundId: vi.fn(async () => null),
      findAwaitingAttachByAppRefundId: vi.fn(async () => awaiting),
      attachProcessorRefundId: vi.fn(async () => undefined),
      updateStatus: vi.fn(async () => ({})),
    } as unknown as ProcessRefundUpdatedDeps['refundsRepo'],
    processorEventsRepo: {
      markProcessed: vi.fn(async () => undefined),
    } as unknown as ProcessRefundUpdatedDeps['processorEventsRepo'],
    invoicingBridge: {
      issueCreditNoteFromRefund: vi.fn(),
      getInvoiceStatus: vi.fn(),
    } as unknown as ProcessRefundUpdatedDeps['invoicingBridge'],
    audit: {
      emit: vi.fn(async () => undefined),
    } as unknown as ProcessRefundUpdatedDeps['audit'],
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2023-11-14T22:13:20.000Z',
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function refundUpdatedInput(
  partial: Partial<ProcessRefundUpdatedInput> = {},
): ProcessRefundUpdatedInput {
  return {
    tenantId: TENANT_ID,
    requestId: 'req-f9',
    eventId: 'evt_f9_refund_updated',
    processorRefundId: PROCESSOR_REFUND_ID,
    chargeId: 'ch_f9',
    refundStatus: 'succeeded',
    sourceEventType: 'refund.updated',
    amountSatang: asSatang(100_000n),
    processorEnv: 'test',
    ...partial,
  };
}

describe('F-9 refund.updated — recognition suppresses the false forensic', () => {
  beforeEach(() => {
    vi.mocked(paymentsMetrics.outOfBandRefundRejected).mockClear();
  });

  it('CONJUNCTION: no OOB audit AND attaches the exact re_ id', async () => {
    const deps = makeRefundUpdatedDeps(awaitingRow());

    const result = await processRefundUpdated(
      deps,
      refundUpdatedInput({
        appRefundId: APP_REFUND_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.kind).toBe('app_refund_backfilled');

    expect(oobEmits(deps.audit)).toHaveLength(0);
    expect(deps.refundsRepo.attachProcessorRefundId).toHaveBeenCalledTimes(1);
    expect(deps.refundsRepo.attachProcessorRefundId).toHaveBeenCalledWith(
      expect.anything(),
      {
        refundId: APP_REFUND_ID,
        tenantId: TENANT_ID,
        processorRefundId: PROCESSOR_REFUND_ID,
      },
    );
    // Repaired, NOT finalised — no credit note was booked despite an incoming
    // `succeeded`. A.11 ownership resumes on the next delivery.
    expect(deps.invoicingBridge.issueCreditNoteFromRefund).not.toHaveBeenCalled();
    expect(deps.refundsRepo.updateStatus).not.toHaveBeenCalled();
    // Still folds markProcessed into the same tx.
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a markerless refund still emits exactly one forensic', async () => {
    const deps = makeRefundUpdatedDeps(awaitingRow());

    const result = await processRefundUpdated(deps, refundUpdatedInput());

    expect(result.ok && result.value.kind).toBe('out_of_band');
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(
      deps.refundsRepo.findAwaitingAttachByAppRefundId,
    ).not.toHaveBeenCalled();
  });

  it('cross-tenant forged marker: no match AND the forensic still fires', async () => {
    const deps = makeRefundUpdatedDeps(null);

    const result = await processRefundUpdated(
      deps,
      refundUpdatedInput({
        tenantId: OTHER_TENANT_ID,
        appRefundId: APP_REFUND_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok && result.value.kind).toBe('out_of_band');
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
  });

  it('PI mismatch: forged marker does NOT suppress the forensic', async () => {
    const deps = makeRefundUpdatedDeps(
      awaitingRow({ parentProcessorPaymentIntentId: 'pi_someone_elses' }),
    );

    const result = await processRefundUpdated(
      deps,
      refundUpdatedInput({
        appRefundId: APP_REFUND_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(result.ok && result.value.kind).toBe('out_of_band');
    expect(oobEmits(deps.audit)).toHaveLength(1);
    expect(deps.refundsRepo.attachProcessorRefundId).not.toHaveBeenCalled();
  });

  /**
   * The charge-less async path (PromptPay / bank transfer) is the ONLY one that
   * pages from this handler. A false page there is the loudest form of the bug.
   */
  it('charge-less async: recognition suppresses the sole paging metric', async () => {
    const deps = makeRefundUpdatedDeps(awaitingRow());

    await processRefundUpdated(
      deps,
      refundUpdatedInput({
        chargeId: null,
        appRefundId: APP_REFUND_ID,
        paymentIntentId: PAYMENT_INTENT_ID,
      }),
    );

    expect(paymentsMetrics.outOfBandRefundRejected).not.toHaveBeenCalled();

    // Control: the same charge-less event WITHOUT a marker still pages.
    const control = makeRefundUpdatedDeps(awaitingRow());
    await processRefundUpdated(control, refundUpdatedInput({ chargeId: null }));
    expect(paymentsMetrics.outOfBandRefundRejected).toHaveBeenCalledTimes(1);
  });
});
