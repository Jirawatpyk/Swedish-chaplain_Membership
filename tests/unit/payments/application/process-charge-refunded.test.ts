/**
 * T130 unit tests — `processChargeRefunded` use-case.
 *
 * Target: 100% branch coverage (Constitution Principle II).
 *
 * Branches covered:
 *   - empty refundIds (no audit emit, markProcessed still fires)
 *   - all unknown refundIds (each emits `out_of_band_refund_detected`)
 *   - all known refundIds (no OOB audit, invoiceId surfaced from first match)
 *   - mixed known + unknown (1 OOB audit + invoiceId from first known match)
 *   - second known (2nd-position) does NOT overwrite first known invoiceId
 *   - withTx rejection → returns `dispatch_failed` Result.err (no throw)
 *   - audit emit rejection inside tx → propagates to `dispatch_failed`
 *
 * SAQ-A invariants asserted:
 *   - `runbook_url` payload field present and matches the documented path
 *   - payload contains processor_refund_id + processor_charge_id +
 *     amount_satang ONLY (no card metadata, no PAN, no signature)
 *   - retentionYears = 10 (out_of_band_refund_detected is forensic 10y)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import {
  processChargeRefunded,
  type ProcessChargeRefundedDeps,
  type ProcessChargeRefundedInput,
} from '@/modules/payments/application/use-cases/process-charge-refunded';
import { asPaymentId } from '@/modules/payments/domain/payment';
import { F5_AUDIT_RETENTION_YEARS } from '@/modules/payments/application/ports/audit-port';

const TENANT_ID = 'tnt_charge_refunded_test';
const RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

function makeDeps(): ProcessChargeRefundedDeps {
  return {
    paymentsRepo: {
      withTx: vi.fn(async (cb) => {
        const tx = { __mock: 'tx' };
        return cb(tx);
      }),
      // Retained so tests can assert charge.refunded does NOT flip the
      // parent payment (A.12 — parent-payment flip + recovery moved to
      // finalizeSucceededRefund / charge.refund.updated, A.11).
      updateStatus: vi.fn(async () => ({})),
    } as unknown as ProcessChargeRefundedDeps['paymentsRepo'],
    refundsRepo: {
      findByProcessorRefundId: vi.fn(async () => null),
      // Retained so tests can assert charge.refunded does NOT flip the
      // refund row (A.12). The former pending-flip that invoked this moved
      // to finalizeSucceededRefund (A.11).
      updateStatus: vi.fn(async () => ({}) as unknown),
    } as unknown as ProcessChargeRefundedDeps['refundsRepo'],
    processorEventsRepo: {
      markProcessed: vi.fn(async () => undefined),
    } as unknown as ProcessChargeRefundedDeps['processorEventsRepo'],
    audit: {
      emit: vi.fn(async () => undefined),
    } as unknown as ProcessChargeRefundedDeps['audit'],
    // review-20260428-102639.md W5 closure — clock now required.
    clock: {
      nowMs: () => 1_700_000_000_000,
      nowIso: () => '2023-11-14T22:13:20.000Z',
    },
  };
}

function makeInput(
  partial: Partial<ProcessChargeRefundedInput> = {},
): ProcessChargeRefundedInput {
  return {
    tenantId: TENANT_ID,
    requestId: 'req-test-001',
    eventId: 'evt_test_charge_refunded',
    chargeId: 'ch_test_001',
    refundIds: [],
    amountSatang: asSatang(100_000n),
    processorEnv: 'test',
    ...partial,
  };
}

describe('processChargeRefunded — T130 100% branch coverage', () => {
  let deps: ProcessChargeRefundedDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('empty refundIds — no audit emitted; markProcessed still fires inside tx', async () => {
    const result = await processChargeRefunded(deps, makeInput({ refundIds: [] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBeUndefined();

    expect(vi.mocked(deps.audit.emit).mock.calls).toHaveLength(0);
    expect(vi.mocked(deps.refundsRepo.findByProcessorRefundId)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('all unknown refundIds — emits one out_of_band_refund_detected per id', async () => {
    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_unknown_1', 're_unknown_2', 're_unknown_3'] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBeUndefined();

    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(3);
    for (const call of auditCalls) {
      expect(call[1].eventType).toBe('out_of_band_refund_detected');
    }
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('all known refundIds (already succeeded) — idempotent webhook: no audit, no flip', async () => {
    // H-1: status='succeeded' is the idempotent-replay scenario where
    // issueRefund's Phase B already finalised. processChargeRefunded
    // is a no-op (no flip + no audit) — the recovery branch only
    // fires when status='pending'.
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(50_000n),
        status: 'succeeded' as const,
        processorRefundId: refundId,
      }),
    );

    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_known_A', 're_known_B'] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stripe semantics — both refunds share same charge → same invoice.
    // Implementation surfaces FIRST DB-existing match. Subsequent matches
    // do NOT overwrite (refundedInvoiceId === undefined guard).
    expect(result.value.invoiceId).toBe('inv-re_known_A');
    expect(vi.mocked(deps.audit.emit).mock.calls).toHaveLength(0);
    expect(vi.mocked(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('A.12 (#2): matched pending refund row → NO flip, NO refund_succeeded audit (finalization deferred to charge.refund.updated)', async () => {
    // A.9 attaches processor_refund_id at refund-creation time, so
    // charge.refunded can now MATCH a pending row — but A.11 makes
    // charge.refund.updated (processRefundUpdated → finalizeSucceededRefund)
    // the SOLE owner of async-refund finalization. charge.refunded must NOT
    // flip the refund row, must NOT flip the parent payment, and must NOT
    // emit refund_succeeded; for a matched pending row it only runs the
    // amount-mismatch sanity check (below) and acks the webhook.
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(50_000n),
        status: 'pending' as const,
        processorRefundId: refundId,
      }),
    );

    const result = await processChargeRefunded(
      deps,
      // DB 50_000 < Stripe 100_000 → NO amount mismatch (the would-be flip
      // path pre-A.12). Post-A.12 this is a pure no-op + ack.
      makeInput({ refundIds: ['re_pending'], amountSatang: asSatang(100_000n) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBe('inv-re_pending');

    // No refund flip — finalization owned by charge.refund.updated (A.11).
    expect(vi.mocked(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    // No parent-payment flip.
    expect(vi.mocked(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
    // No refund_succeeded audit from this branch.
    const eventTypes = vi
      .mocked(deps.audit.emit)
      .mock.calls.map((c) => c[1].eventType);
    expect(eventTypes).not.toContain('refund_succeeded');
    // Still acks the webhook (markProcessed inside the same tx).
    expect(
      vi.mocked(deps.processorEventsRepo.markProcessed),
    ).toHaveBeenCalledTimes(1);
  });

  it('mixed: unknown then known — emits 1 OOB audit + invoiceId from the known match', async () => {
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => {
        if (refundId === 're_unknown') return null;
        return {
          id: `rfd_${refundId}`,
          tenantId: TENANT_ID,
          paymentId: asPaymentId('pmt_test'),
          invoiceId: `inv-${refundId}`,
          amountSatang: asSatang(50_000n),
          status: 'succeeded' as const,
          processorRefundId: refundId,
        };
      },
    );

    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_unknown', 're_known'] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBe('inv-re_known');

    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]![1].eventType).toBe('out_of_band_refund_detected');
  });

  it('first known stays — second known does NOT overwrite refundedInvoiceId', async () => {
    // status='succeeded' so the H-1 recovery branch does not fire and
    // pollute the audit count — this test pins the FIRST-match
    // selection invariant only.
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(50_000n),
        status: 'succeeded' as const,
        processorRefundId: refundId,
      }),
    );

    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_first', 're_second'] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invoiceId).toBe('inv-re_first');
    expect(result.value.invoiceId).not.toBe('inv-re_second');
  });

  it('SAQ-A: out_of_band audit payload contains runbook_url + ref ids only (no PII / card)', async () => {
    const result = await processChargeRefunded(
      deps,
      makeInput({
        refundIds: ['re_oob'],
        chargeId: 'ch_oob_test',
        amountSatang: asSatang(5_350_000n),
      }),
    );
    expect(result.ok).toBe(true);

    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(1);
    const auditEvent = auditCalls[0]![1];
    expect(auditEvent.eventType).toBe('out_of_band_refund_detected');
    expect(auditEvent.payload).toEqual({
      processor_refund_id: 're_oob',
      processor_charge_id: 'ch_oob_test',
      amount_satang: '5350000',
      runbook_url: RUNBOOK_URL,
    });
    // SAQ-A negative invariants — no card metadata / PAN / signature
    // sneaks through (defense-in-depth on payload shape).
    const payloadKeys = Object.keys(auditEvent.payload);
    expect(payloadKeys).not.toContain('card');
    expect(payloadKeys).not.toContain('card_number');
    expect(payloadKeys).not.toContain('pan');
    expect(payloadKeys).not.toContain('cvv');
    expect(payloadKeys).not.toContain('last4');
    expect(payloadKeys).not.toContain('Stripe-Signature');
    expect(payloadKeys).not.toContain('stripe_signature');
  });

  it('out_of_band_refund_detected carries 10-year retention (forensic record)', async () => {
    expect(F5_AUDIT_RETENTION_YEARS['out_of_band_refund_detected']).toBe(10);
    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_retention_check'] }),
    );
    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls[0]![1].retentionYears).toBe(10);
  });

  it('withTx rejection → dispatch_failed Result.err (no throw, cause forwarded)', async () => {
    const txError = new Error('postgres double-fault simulation');
    vi.mocked(deps.paymentsRepo.withTx).mockRejectedValue(txError);

    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_xx'] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.cause).toBe(txError);
    // markProcessed NEVER fires when withTx itself rejects (the inner
    // callback's markProcessed call is rolled back together with audits).
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).not.toHaveBeenCalled();
  });

  it('audit.emit rejection inside tx → dispatch_failed (atomic rollback semantics)', async () => {
    const auditError = new Error('audit table outage');
    vi.mocked(deps.audit.emit).mockRejectedValue(auditError);
    vi.mocked(deps.paymentsRepo.withTx).mockImplementation(async (cb) => {
      // Run the callback — when audit.emit rejects, withTx rejects too,
      // matching the production Drizzle withTx contract.
      return cb({ __mock: 'tx' });
    });

    const result = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_unknown_audit_fail'] }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.cause).toBe(auditError);
  });

  it('idempotency on second delivery: known refundIds → no double audit', async () => {
    // Simulate Stripe re-delivering the same event after a first GREEN
    // commit. All refund ids are now KNOWN (the in-app issueRefund
    // landed on first delivery), so the OOB branch never fires. The
    // dispatcher gates duplicates upstream via `processor_events`
    // ON CONFLICT, but if a duplicate ever reached this use-case, it
    // would no-op cleanly (no double audit).
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(50_000n),
        status: 'succeeded' as const,
        processorRefundId: refundId,
      }),
    );

    // Two consecutive calls with the same refund ids.
    const result1 = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_dup'] }),
    );
    const result2 = await processChargeRefunded(
      deps,
      makeInput({ refundIds: ['re_dup'] }),
    );

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    // Zero OOB audits across BOTH deliveries (refund is known on each).
    expect(vi.mocked(deps.audit.emit).mock.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------------------
  // Remaining pending-row branches (post-A.12):
  //   - refund_amount_mismatch_detected (F5R2-SF-6) — still fires on divergence
  //   - amountProjectionFailed bypass (F5R3v3 H-4) — no mismatch, no flip
  //
  // A.12 (2026-07-11) removed the pending-flip + parent-recovery block from
  // this use-case (finalisation is now solely owned by
  // `charge.refund.updated` → `processRefundUpdated` → `finalizeSucceededRefund`,
  // A.11). The former parent-recovery branch tests (recovery→refunded,
  // recovery-race→logger.warn, null-parent skip, already-at-next-status skip)
  // moved WITH that logic: their coverage now lives in the A.11
  // `finalizeSucceededRefund` / `processRefundUpdated` suites, not here.
  // ---------------------------------------------------------------------

  it('F5R2-SF-6 — refund_amount_mismatch_detected fires when DB amount > Stripe amount', async () => {
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(200_000n), // DB > Stripe
        status: 'pending' as const,
        processorRefundId: refundId,
      }),
    );

    const result = await processChargeRefunded(
      deps,
      makeInput({
        refundIds: ['re_mismatch'],
        amountSatang: asSatang(100_000n), // Stripe < DB
      }),
    );

    expect(result.ok).toBe(true);

    // Audit emit fires with refund_amount_mismatch_detected; NO refund
    // flip + NO refund_succeeded emit (continue short-circuit).
    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]![1].eventType).toBe('refund_amount_mismatch_detected');
    expect(auditCalls[0]![1].payload).toMatchObject({
      refund_id: 'rfd_re_mismatch',
      payment_id: 'pmt_test',
      db_amount_satang: '200000',
      stripe_amount_satang: '100000',
      runbook_url: RUNBOOK_URL,
    });
    expect(vi.mocked(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('F5R3v3 H-4 — amountProjectionFailed=true SKIPS the mismatch check (no mismatch audit, no flip)', async () => {
    // Even though DB amount (200_000) > input amount (0n default), the
    // projection-failed flag means we MUST NOT compare — so NO
    // refund_amount_mismatch_detected fires. Post-A.12 the pending row is
    // also NOT flipped here (charge.refund.updated finalises it).
    vi.mocked(deps.refundsRepo.findByProcessorRefundId).mockImplementation(
      async (_tx, _t, refundId) => ({
        id: `rfd_${refundId}`,
        tenantId: TENANT_ID,
        paymentId: asPaymentId('pmt_test'),
        invoiceId: `inv-${refundId}`,
        amountSatang: asSatang(200_000n),
        status: 'pending' as const,
        processorRefundId: refundId,
      }),
    );

    const result = await processChargeRefunded(
      deps,
      makeInput({
        refundIds: ['re_proj_failed'],
        amountSatang: asSatang(0n),
        amountProjectionFailed: true,
      }),
    );

    expect(result.ok).toBe(true);

    // No flip (mismatch bypassed, but finalisation is deferred to
    // charge.refund.updated).
    expect(vi.mocked(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    // Neither a mismatch audit NOR a refund_succeeded audit.
    const eventTypes = vi
      .mocked(deps.audit.emit)
      .mock.calls.map((c) => c[1].eventType);
    expect(eventTypes).not.toContain('refund_amount_mismatch_detected');
    expect(eventTypes).not.toContain('refund_succeeded');
  });

});
