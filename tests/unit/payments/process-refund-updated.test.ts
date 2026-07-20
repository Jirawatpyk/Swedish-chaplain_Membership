/**
 * PR-A Task A.11 unit tests — `processRefundUpdated` use-case.
 *
 * Reconciles async refunds via the Stripe `charge.refund.updated` webhook
 * (bugs #1 reconcile, #2). Target: 100% BRANCH coverage (security-critical,
 * Constitution Principle II) — every outcome kind + the null-race sub-branch.
 *
 * Outcome kinds:
 *   reconciled_succeeded | reconciled_failed | already_finalized |
 *   still_pending | out_of_band | auto_refund_recognized | auto_refund_failed
 *
 * These tests drive the REAL `finalizeSucceededRefund` helper (webhook mode,
 * `paymentNextStatus` omitted → self-lock payment + SB-1 recovery), mocking
 * only the ports — so the SB-1 port is exercised end-to-end here while the
 * admin path's Phase-A-snapshot mode stays covered by issue-refund.test.ts.
 *
 * SAQ-A invariants asserted:
 *   - audit payloads carry id-refs + status + satang ONLY (no card / raw
 *     event / error.message).
 *   - `auto_refund_failed_needs_manual_reconcile` retention = 10y.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { asSatang } from '@/lib/money';
import {
  processRefundUpdated,
  type ProcessRefundUpdatedDeps,
  type ProcessRefundUpdatedInput,
} from '@/modules/payments/application/use-cases/process-refund-updated';
import { asPaymentId } from '@/modules/payments/domain/payment';
import { asRefundId, type Refund } from '@/modules/payments/domain/refund';
import { F5_AUDIT_RETENTION_YEARS } from '@/modules/payments/application/ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments/domain/system-actors';
import { paymentsMetrics } from '@/lib/metrics';

const TENANT_ID = 'tnt_refund_updated_test';
const OOB_RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: {
      ...actual.paymentsMetrics,
      outOfBandRefundRejected: vi.fn(),
      refundFailedCount: vi.fn(),
      refundSucceededCount: vi.fn(),
      autoRefundFailedNeedsReconcile: vi.fn(),
    },
  };
});

function makeRefund(partial: Partial<Refund> = {}): Refund {
  return {
    id: asRefundId('rfnd_01hxxxxxxxxxxxxxxxxxxxxxxx'),
    tenantId: TENANT_ID,
    paymentId: asPaymentId('pmt_01hyyyyyyyyyyyyyyyyyyyyyyy'),
    invoiceId: 'inv_test_1',
    amountSatang: asSatang(50_000n),
    reason: 'requested_by_customer',
    status: 'pending',
    processorRefundId: 're_test_1',
    failureReasonCode: null,
    creditNoteId: null,
    // Track B — the webhook finaliser reads the waiver decision off the ROW
    // (it was pinned at Phase-A insert). Omitting these leaves them `undefined`,
    // and the finaliser's `waiverReason === null` test then takes the WAIVE arm
    // for an ordinary refund — silently skipping credit-note issuance. Explicit
    // nulls are load-bearing here, not boilerplate.
    creditNoteWaivedAt: null,
    creditNoteWaiverReason: null,
    initiatedAt: new Date('2026-07-11T00:00:00.000Z'),
    completedAt: null,
    initiatorUserId: 'usr_admin_1',
    correlationId: 'corr-1',
    ...partial,
  };
}

function makeDeps(): ProcessRefundUpdatedDeps {
  return {
    paymentsRepo: {
      withTx: vi.fn(async (cb) => cb({ __mock: 'tx' })),
      // webhook-mode SB-1: helper locks the payment FOR UPDATE, default is
      // a `succeeded` parent with 100k amount so a 50k refund derives
      // `partially_refunded` (a distinct next status → flip fires).
      lockForUpdate: vi.fn(async () => ({
        id: asPaymentId('pmt_01hyyyyyyyyyyyyyyyyyyyyyyy'),
        tenantId: TENANT_ID,
        status: 'succeeded' as const,
        amountSatang: asSatang(100_000n),
      })),
      // payment flip returns a non-null row (flip succeeded, not raced).
      updateStatus: vi.fn(async () => ({})),
      findAutoRefundByProcessorRefundId: vi.fn(async () => null),
    } as unknown as ProcessRefundUpdatedDeps['paymentsRepo'],
    refundsRepo: {
      lockForUpdateByProcessorRefundId: vi.fn(async () => null),
      // refund flip returns a non-null row → siblingWon = false.
      updateStatus: vi.fn(async () => ({})),
      getRefundContextForUpdate: vi.fn(async () => ({
        pendingCount: 0,
        succeededSumSatang: asSatang(50_000n),
        nextSeq: 2,
      settledUnbookedCount: 0,
      })),
    } as unknown as ProcessRefundUpdatedDeps['refundsRepo'],
    processorEventsRepo: {
      markProcessed: vi.fn(async () => undefined),
    } as unknown as ProcessRefundUpdatedDeps['processorEventsRepo'],
    invoicingBridge: {
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({ creditNoteId: 'cn_test_1', creditNoteNumber: 'CN-2026-0001' }),
      ),
      // tax#5 (B.2) — the shared finaliser reads the F4-authoritative invoice
      // status on the succeeded path. The webhook outcome does not surface it,
      // so the value is inert here; must be present or the real finaliser throws.
      getInvoiceStatus: vi.fn(async () => ok('credited' as const)),
      // 8B — on a Phase-B credit-note DECLINE the finaliser re-consults F4's
      // Domain verdict. Default `issue` (invoice NOT void) → the decline still
      // DEFERS, exactly as before this fix. Without this stub the decline test
      // below reaches `undefined(...)` and passes via a TypeError instead of
      // the real defer path.
      getInvoiceCreditedTotal: vi.fn(async () =>
        ok({
          creditedTotalSatang: asSatang(0n),
          totalSatang: asSatang(100_000n),
          creditNoteRequirement: { kind: 'issue' as const },
        }),
      ),
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

function makeInput(
  partial: Partial<ProcessRefundUpdatedInput> = {},
): ProcessRefundUpdatedInput {
  return {
    tenantId: TENANT_ID,
    requestId: 'req-ru-001',
    eventId: 'evt_refund_updated_1',
    processorRefundId: 're_test_1',
    chargeId: 'ch_test_1',
    refundStatus: 'succeeded',
    amountSatang: asSatang(50_000n),
    processorEnv: 'test',
    ...partial,
  };
}

describe('processRefundUpdated — A.11 100% branch coverage', () => {
  let deps: ProcessRefundUpdatedDeps;

  beforeEach(() => {
    deps = makeDeps();
    vi.mocked(paymentsMetrics.outOfBandRefundRejected).mockClear();
    vi.mocked(paymentsMetrics.refundFailedCount).mockClear();
    vi.mocked(paymentsMetrics.refundSucceededCount).mockClear();
  });

  // -------------------------------------------------------------------------
  // Refund NOT found → auto-refund / out-of-band branches
  // -------------------------------------------------------------------------

  it('not found + auto-refund matched + incoming succeeded → auto_refund_recognized (audit-silent + logged); markProcessed', async () => {
    vi.mocked(deps.paymentsRepo.findAutoRefundByProcessorRefundId).mockResolvedValueOnce({
      paymentId: asPaymentId('pmt_auto_1'),
      invoiceId: 'inv_auto_1',
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_recognized');
    if (result.value.kind !== 'auto_refund_recognized') return;
    expect(result.value.invoiceId).toBe('inv_auto_1');
    // Audit-silent — the money-trail was already recorded at the
    // `payment_auto_refunded_stale_invoice` emit (A.13).
    expect(vi.mocked(deps.audit.emit)).not.toHaveBeenCalled();
    // Ops trace (PCI-clean structured log).
    expect(vi.mocked(deps.logger!.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('not found + auto-refund matched + incoming pending → auto_refund_recognized (still-in-flight, benign)', async () => {
    vi.mocked(deps.paymentsRepo.findAutoRefundByProcessorRefundId).mockResolvedValueOnce({
      paymentId: asPaymentId('pmt_auto_2'),
      invoiceId: 'inv_auto_2',
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'pending' }));

    expect(result.ok && result.value.kind).toBe('auto_refund_recognized');
    expect(vi.mocked(deps.audit.emit)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('not found + auto-refund matched + incoming succeeded WITHOUT a logger → still recognized (optional-logger branch)', async () => {
    const noLoggerDeps = makeDeps();
    delete (noLoggerDeps as { logger?: unknown }).logger;
    vi.mocked(noLoggerDeps.paymentsRepo.findAutoRefundByProcessorRefundId).mockResolvedValueOnce({
      paymentId: asPaymentId('pmt_auto_3'),
      invoiceId: 'inv_auto_3',
    });

    const result = await processRefundUpdated(noLoggerDeps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok && result.value.kind).toBe('auto_refund_recognized');
    expect(vi.mocked(noLoggerDeps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('not found + auto-refund matched + incoming failed → auto_refund_failed (10y audit, NOT suppressed); markProcessed', async () => {
    vi.mocked(deps.paymentsRepo.findAutoRefundByProcessorRefundId).mockResolvedValueOnce({
      paymentId: asPaymentId('pmt_auto_4'),
      invoiceId: 'inv_auto_4',
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'failed' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_failed');

    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(1);
    const evt = auditCalls[0]![1];
    expect(evt.eventType).toBe('auto_refund_failed_needs_manual_reconcile');
    expect(evt.retentionYears).toBe(10);
    expect(F5_AUDIT_RETENTION_YEARS.auto_refund_failed_needs_manual_reconcile).toBe(10);
    // RR-8 allow-list — id-refs + status + satang + runbook ONLY. No card,
    // no raw event, no error.message.
    expect(evt.payload).toEqual({
      payment_id: 'pmt_auto_4',
      invoice_id: 'inv_auto_4',
      auto_refund_processor_refund_id: 're_test_1',
      refund_status: 'failed',
      amount_satang: '50000',
      runbook_url: OOB_RUNBOOK_URL,
    });
    expect(evt.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK);
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
    // A.16 (H-e) — the money-not-returned forensic path also increments the
    // paging counter so on-call is alerted (pino logs roll off; the counter
    // anchors the long-term alert).
    expect(vi.mocked(paymentsMetrics.autoRefundFailedNeedsReconcile)).toHaveBeenCalledWith(
      TENANT_ID,
    );
  });

  it('not found + auto-refund matched + incoming canceled → auto_refund_failed (canceled classifies as failed)', async () => {
    vi.mocked(deps.paymentsRepo.findAutoRefundByProcessorRefundId).mockResolvedValueOnce({
      paymentId: asPaymentId('pmt_auto_5'),
      invoiceId: 'inv_auto_5',
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'canceled' }));

    expect(result.ok && result.value.kind).toBe('auto_refund_failed');
    const evt = vi.mocked(deps.audit.emit).mock.calls[0]![1];
    expect(evt.eventType).toBe('auto_refund_failed_needs_manual_reconcile');
    expect((evt.payload as { refund_status: string }).refund_status).toBe('canceled');
  });

  it('Finding 4 — not found + no auto-refund → out_of_band; emits the redundant 10y forensic audit (dedup-on-read) but NOT the paging metric (single-owner on charge.refunded)', async () => {
    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('out_of_band');

    // SPLIT ownership (money-trail forensic ⇒ redundancy). The
    // `out_of_band_refund_detected` audit is emitted REDUNDANTLY from BOTH the
    // `charge.refunded` and `charge.refund.updated` handlers so the 10y forensic
    // has no single point of failure (duplicates deduped on read by
    // processor_refund_id). This handler MUST emit it.
    const auditCalls = vi.mocked(deps.audit.emit).mock.calls;
    expect(auditCalls).toHaveLength(1);
    const evt = auditCalls[0]![1];
    expect(evt.eventType).toBe('out_of_band_refund_detected');
    expect(evt.retentionYears).toBe(10);
    expect(F5_AUDIT_RETENTION_YEARS.out_of_band_refund_detected).toBe(10);
    expect(evt.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK);
    // RR-8 allow-list — id-refs + status + satang + runbook ONLY. No card, no
    // raw event, no error.message.
    expect(evt.payload).toEqual({
      processor_refund_id: 're_test_1',
      processor_charge_id: 'ch_test_1',
      amount_satang: '50000',
      runbook_url: OOB_RUNBOOK_URL,
    });
    // The paging metric stays SINGLE-OWNER on `processChargeRefunded` (the
    // universal detector that fires on every refund). Emitting it here too would
    // double-count the async path — so this handler must NOT bump it.
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).not.toHaveBeenCalled();
    // Acked so Stripe stops re-delivering THIS event (atomic with the audit).
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('Finding 4 — not found + no auto-refund + null chargeId → out_of_band; audit payload uses the `unknown` processor_charge_id sentinel', async () => {
    const result = await processRefundUpdated(deps, makeInput({ chargeId: null }));

    expect(result.ok && result.value.kind).toBe('out_of_band');
    const evt = vi.mocked(deps.audit.emit).mock.calls[0]![1];
    expect(evt.eventType).toBe('out_of_band_refund_detected');
    // The payload requires a string; a null chargeId maps to an explicit
    // `unknown` sentinel (a misleading value would be worse).
    expect((evt.payload as { processor_charge_id: string }).processor_charge_id).toBe('unknown');
    // Fix 1 — a charge-less OOB (null chargeId) NEVER fires `charge.refunded`,
    // so THIS handler is its sole detector and DOES page (see the dedicated
    // charge-less test below for the full both-emissions invariant).
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
  });

  it('Fix 1 — charge-less genuine OOB via refund.updated (chargeId null) → emits BOTH the 10y forensic audit AND the paging metric exactly once (sole detector: no charge.refunded fires)', async () => {
    const result = await processRefundUpdated(
      deps,
      makeInput({ chargeId: null, sourceEventType: 'refund.updated' }),
    );

    expect(result.ok && result.value.kind).toBe('out_of_band');

    // Forensic audit — exactly one out_of_band_refund_detected row (10y).
    const oobAudits = vi
      .mocked(deps.audit.emit)
      .mock.calls.filter((c) => c[1].eventType === 'out_of_band_refund_detected');
    expect(oobAudits).toHaveLength(1);
    expect(oobAudits[0]![1].retentionYears).toBe(10);

    // Paging metric — the charge-less EXCEPTION to single-owner: emitted here
    // exactly once with (tenantId, processorEnv) so on-call is paged in real
    // time (charge.refunded can never fire for a charge-less refund).
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).toHaveBeenCalledWith(
      TENANT_ID,
      'test',
    );
  });

  it('Fix 1 — with-charge genuine OOB via refund.updated (chargeId set) → forensic audit but NOT the paging metric (single-owner stays on charge.refunded, which still fires for charged refunds)', async () => {
    const result = await processRefundUpdated(
      deps,
      makeInput({ chargeId: 'ch_has_charge', sourceEventType: 'refund.updated' }),
    );

    expect(result.ok && result.value.kind).toBe('out_of_band');

    const oobAudits = vi
      .mocked(deps.audit.emit)
      .mock.calls.filter((c) => c[1].eventType === 'out_of_band_refund_detected');
    expect(oobAudits).toHaveLength(1);
    // charge.refunded is the single owner for charged refunds → this handler
    // must NOT bump the metric (would double-count the async path).
    expect(vi.mocked(paymentsMetrics.outOfBandRefundRejected)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Refund found, already terminal → already_finalized no-op
  // -------------------------------------------------------------------------

  it('found + status succeeded (already terminal) → already_finalized no-op; no audit; markProcessed', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'succeeded', creditNoteId: 'cn_prev', completedAt: new Date() }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_finalized');
    if (result.value.kind !== 'already_finalized') return;
    expect(result.value.invoiceId).toBe('inv_test_1');
    expect(vi.mocked(deps.audit.emit)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + status failed (already terminal) → already_finalized no-op', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'failed', failureReasonCode: 'stripe_refund_failed', completedAt: new Date() }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok && result.value.kind).toBe('already_finalized');
    expect(vi.mocked(deps.audit.emit)).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Refund found + pending → finalize / fail / still-pending
  // -------------------------------------------------------------------------

  it('found + pending + incoming succeeded (partial) → reconciled_succeeded via finalizeSucceededRefund; refund_succeeded audit (webhook_refund_updated)', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending', amountSatang: asSatang(50_000n) }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reconciled_succeeded');
    if (result.value.kind !== 'reconciled_succeeded') return;
    expect(result.value.creditNoteId).toBe('cn_test_1');
    expect(result.value.creditNoteNumber).toBe('CN-2026-0001');
    expect(result.value.invoiceId).toBe('inv_test_1');

    // SB-1 port: payment locked FOR UPDATE, aggregate read, race-guarded flip.
    expect(vi.mocked(deps.paymentsRepo.lockForUpdate)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.refundsRepo.getRefundContextForUpdate)).toHaveBeenCalledTimes(1);
    // partial (50k of 100k) → payment advanced to partially_refunded.
    const payFlip = vi.mocked(deps.paymentsRepo.updateStatus).mock.calls[0]![1];
    expect(payFlip.nextStatus).toBe('partially_refunded');
    expect(payFlip.expectedCurrentStatus).toBe('succeeded');

    // refund_succeeded audit carries the webhook_refund_updated discriminator.
    const succeededAudit = vi
      .mocked(deps.audit.emit)
      .mock.calls.find((c) => c[1].eventType === 'refund_succeeded');
    expect(succeededAudit).toBeDefined();
    expect((succeededAudit![1].payload as { path: string }).path).toBe('webhook_refund_updated');
    expect((succeededAudit![1].payload as { payment_next_status: string }).payment_next_status).toBe(
      'partially_refunded',
    );
    // Guard #2 — THIS writer performed the flip (siblingWon===false) → owns
    // the refundSucceededCount increment.
    expect(vi.mocked(paymentsMetrics.refundSucceededCount)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + succeeded + WAIVER on the row → settles with NO credit note, both bridge calls skipped', async () => {
    // Track B — the production-reachable async waive: a §105 (or voided-invoice)
    // refund settles via `charge.refund.updated`, so the finaliser runs in
    // WEBHOOK mode against a locked row that already carries the waiver decision
    // (stamped at Phase-A insert). This path had ZERO waiver coverage, and it is
    // the exact call-site of the original stuck-row bug: the waive arm must NOT
    // call `getInvoiceStatus` (it errors for `paid`/`void`) or
    // `issueCreditNoteFromRefund`, and must stamp the waiver instead.
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({
        status: 'pending',
        amountSatang: asSatang(50_000n),
        creditNoteWaiverReason: 'section_105_receipt',
      }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== 'reconciled_succeeded') {
      throw new Error('expected reconciled_succeeded on the waive path');
    }
    // No §86/10 exists or ever will.
    expect(result.value.creditNoteId).toBeNull();

    // THE regression guards: neither external call is made on the waive arm.
    // A future edit that re-adds a `getInvoiceStatus` read here is the silent-
    // wrong-return shape the review flagged — the default mock returns
    // `ok('credited')`, so it would NOT throw and would ship undetected without
    // this assertion.
    expect(vi.mocked(deps.invoicingBridge.getInvoiceStatus)).not.toHaveBeenCalled();
    expect(
      vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund),
    ).not.toHaveBeenCalled();

    // The refund flip stamps the settlement timestamp, not a credit note id —
    // this is what the 0268 completeness CHECK keys on.
    const refundFlip = vi.mocked(deps.refundsRepo.updateStatus).mock.calls[0]![1] as {
      creditNoteWaivedAt?: Date;
      creditNoteId?: string;
    };
    expect(refundFlip.creditNoteWaivedAt).toBeInstanceOf(Date);
    expect(refundFlip.creditNoteId).toBeUndefined();

    // refund_succeeded audit: null CN, null invoice status, waiver ground recorded.
    const succeededAudit = vi
      .mocked(deps.audit.emit)
      .mock.calls.find((c) => c[1].eventType === 'refund_succeeded');
    expect(succeededAudit).toBeDefined();
    expect(succeededAudit![1].payload).toMatchObject({
      path: 'webhook_refund_updated',
      credit_note_id: null,
      invoice_next_status: null,
      credit_note_waiver_reason: 'section_105_receipt',
    });
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + incoming succeeded (full) → reconciled_succeeded; payment advanced to refunded', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending', amountSatang: asSatang(100_000n) }),
    );
    vi.mocked(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(100_000n),
      nextSeq: 2,
      settledUnbookedCount: 0,
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok && result.value.kind).toBe('reconciled_succeeded');
    const payFlip = vi.mocked(deps.paymentsRepo.updateStatus).mock.calls[0]![1];
    expect(payFlip.nextStatus).toBe('refunded');
  });

  it('found + pending + incoming succeeded but sibling won the refund-flip race → already_finalized (no double audit / double flip)', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );
    // refund flip guard matched ZERO rows → a concurrent writer finalised first.
    vi.mocked(deps.refundsRepo.updateStatus).mockResolvedValueOnce(null);

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_finalized');
    // No payment flip, no refund_succeeded audit (sibling owns them).
    expect(vi.mocked(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(
      vi.mocked(deps.audit.emit).mock.calls.filter((c) => c[1].eventType === 'refund_succeeded'),
    ).toHaveLength(0);
    // Guard #2 — sibling already counted this refund; THIS writer must NOT
    // double-increment refundSucceededCount.
    expect(vi.mocked(paymentsMetrics.refundSucceededCount)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + incoming succeeded but F4 CN bridge declines → dispatch_failed err; refund NOT marked failed; markProcessed NOT called', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );
    vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      err({ code: 'bridge_error', detail: 'invoice_in_unexpected_state' }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    // Stripe confirmed succeeded — never mark the refund failed on a CN decline.
    expect(
      vi.mocked(deps.refundsRepo.updateStatus).mock.calls.filter(
        (c) => c[1].nextStatus === 'failed',
      ),
    ).toHaveLength(0);
    // No markProcessed → Stripe retries (A.14 sweep is the backstop).
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).not.toHaveBeenCalled();
  });

  it('found + pending + incoming failed → reconciled_failed (no CN); refund_failed audit; markProcessed', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'failed' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reconciled_failed');
    if (result.value.kind !== 'reconciled_failed') return;
    expect(result.value.invoiceId).toBe('inv_test_1');

    // refund flipped → failed with the Stripe-status reason code.
    const failFlip = vi.mocked(deps.refundsRepo.updateStatus).mock.calls[0]![1];
    expect(failFlip.nextStatus).toBe('failed');
    expect(failFlip.failureReasonCode).toBe('stripe_refund_failed');
    // No CN, no payment flip.
    expect(vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund)).not.toHaveBeenCalled();

    const failAudit = vi
      .mocked(deps.audit.emit)
      .mock.calls.find((c) => c[1].eventType === 'refund_failed');
    expect(failAudit).toBeDefined();
    expect(vi.mocked(paymentsMetrics.refundFailedCount)).toHaveBeenCalledWith(
      TENANT_ID,
      'stripe_refund_failed',
    );
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + incoming canceled → reconciled_failed (canceled classifies as failed)', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'canceled' }));

    expect(result.ok && result.value.kind).toBe('reconciled_failed');
    const failFlip = vi.mocked(deps.refundsRepo.updateStatus).mock.calls[0]![1];
    expect(failFlip.failureReasonCode).toBe('stripe_refund_canceled');
  });

  it('found + pending + incoming pending → still_pending no-op; no audit; markProcessed', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'pending' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('still_pending');
    expect(vi.mocked(deps.audit.emit)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + incoming requires_action / unknown / null → still_pending (never finalizes on non-terminal status)', async () => {
    for (const refundStatus of ['requires_action', 'weird_unknown', null] as const) {
      const d = makeDeps();
      vi.mocked(d.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
        makeRefund({ status: 'pending' }),
      );
      const result = await processRefundUpdated(d, makeInput({ refundStatus }));
      expect(result.ok && result.value.kind).toBe('still_pending');
      expect(vi.mocked(d.audit.emit)).not.toHaveBeenCalled();
    }
  });

  // -------------------------------------------------------------------------
  // SB-1 parent-recovery race + outer catch
  // -------------------------------------------------------------------------

  it('found + pending + succeeded + lockForUpdate returns null (parent payment not found) → still reconciled_succeeded; recovery skipped, no payment flip, refund still finalized', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );
    // SB-1 defensive branch: the self-lock finds no parent payment row.
    // Should be practically unreachable (a refund cannot exist without its
    // parent payment), but the helper defends against it — see
    // `_finalize-succeeded-refund.ts` `parent != null` guards.
    vi.mocked(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(null);

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('reconciled_succeeded');
    // `parent != null` guards the recovery flip — a null parent means the
    // whole recovery `if` is skipped, so the payment row is NEVER touched.
    expect(vi.mocked(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
    // The refund is still finalized: CN issued, refund row flipped, and
    // `refund_succeeded` audited — NOT blocked by the missing parent.
    expect(vi.mocked(deps.invoicingBridge.issueCreditNoteFromRefund)).toHaveBeenCalledTimes(1);
    const succeededAudit = vi
      .mocked(deps.audit.emit)
      .mock.calls.find((c) => c[1].eventType === 'refund_succeeded');
    expect(succeededAudit).toBeDefined();
    expect((succeededAudit![1].payload as { payment_next_status: string }).payment_next_status).toBe(
      'partially_refunded',
    );
    expect(vi.mocked(paymentsMetrics.refundSucceededCount)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + succeeded + payment-flip loses the expectedCurrentStatus race → still reconciled_succeeded (parent-recovery race warn, benign)', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending' }),
    );
    // Payment flip matched ZERO rows (a concurrent writer advanced the parent).
    vi.mocked(deps.paymentsRepo.updateStatus).mockResolvedValueOnce(null);

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok && result.value.kind).toBe('reconciled_succeeded');
    expect(vi.mocked(deps.logger!.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.processorEventsRepo.markProcessed)).toHaveBeenCalledTimes(1);
  });

  it('found + pending + succeeded + parent already at target status → no redundant payment flip', async () => {
    vi.mocked(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeRefund({ status: 'pending', amountSatang: asSatang(100_000n) }),
    );
    // Parent already `refunded`; full-refund derivation also yields `refunded`.
    vi.mocked(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce({
      id: asPaymentId('pmt_01hyyyyyyyyyyyyyyyyyyyyyyy'),
      tenantId: TENANT_ID,
      status: 'refunded' as const,
      amountSatang: asSatang(100_000n),
    } as never);
    vi.mocked(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(100_000n),
      nextSeq: 2,
      settledUnbookedCount: 0,
    });

    const result = await processRefundUpdated(deps, makeInput({ refundStatus: 'succeeded' }));

    expect(result.ok && result.value.kind).toBe('reconciled_succeeded');
    // parent.status === resolvedNextStatus → the flip is skipped.
    expect(vi.mocked(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('withTx throws (DB outage) → dispatch_failed err (no throw escapes the Application layer)', async () => {
    vi.mocked(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw new Error('neon connection reset');
    });

    const result = await processRefundUpdated(deps, makeInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
  });
});
