/**
 * T056 unit tests — processWebhookEvent use-case.
 * Target: 100% branch coverage (Constitution Principle II).
 *
 * Covers:
 *   - idempotency (duplicate → short-circuit)
 *   - dispatch matrix: succeeded / failed / canceled / refunded /
 *     dispute / unknown
 *   - structured allow-list guard (no raw data.object in sub-use-case args)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import {
  processWebhookEvent,
  type ProcessWebhookEventDeps,
} from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';
import type { VerifiedStripeEvent } from '../../../../src/modules/payments/application/ports';

const TENANT_ID = 'tnt_abc';
const PINNED_API = '2024-06-20';

const SETTINGS_OK: TenantPaymentSettings = {
  tenantId: TENANT_ID,
  processor: 'stripe',
  processorEnvironment: 'test',
  processorAccountId: 'acct_test_123',
  processorPublishableKey: 'pk_test_abc',
  enabledMethods: ['card', 'promptpay'],
  onlinePaymentEnabled: true,
  autoEmailOnPayment: true,
  promptpayQrExpirySeconds: 900,
  allowAnonymousPaylink: false,
};

const PENDING_PAYMENT: Payment = {
  id: asPaymentId('pmt_01J_TEST'),
  tenantId: TENANT_ID,
  invoiceId: 'inv_01JABCDE_XYZ',
  memberId: 'mem_01J_MEM',
  method: 'card',
  status: 'pending',
  amountSatang: asSatang(5_350_000n),
  currency: 'THB',
  processorPaymentIntentId: 'pi_test_001',
  processorChargeId: null,
  processorEnvironment: 'test',
  attemptSeq: 1,
  card: null,
  failureReasonCode: null,
  initiatedAt: new Date('2026-05-12T06:00:00Z'),
  completedAt: null,
  actorUserId: 'usr_01J_U',
  correlationId: 'corr_1',
};

function makeEvent(overrides: Partial<VerifiedStripeEvent> = {}): VerifiedStripeEvent {
  return {
    id: 'evt_test_001',
    type: 'payment_intent.succeeded',
    apiVersion: PINNED_API,
    livemode: false,
    account: 'acct_test_123',
    createdAtUnixSeconds: 1_747_033_200,
    dataObject: {
      id: 'pi_test_001',
      type: 'payment_intent',
      latestChargeId: 'ch_test_001',
      lastPaymentErrorCode: null,
    },
    ...overrides,
  };
}

function makeDeps(): ProcessWebhookEventDeps {
  const paymentsRepo = {
    withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({})),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(async () => PENDING_PAYMENT),
    insert: vi.fn(),
    updateStatus: vi.fn(async () => PENDING_PAYMENT),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(async () => []),
    nextAttemptSeq: vi.fn(),
    // A.11 — durable auto-refund lookup used by processRefundUpdated when
    // no in-app refund row matches; default `null` → out-of-band path.
    findAutoRefundByProcessorRefundId: vi.fn(async () => null),
  };
  const refundsRepo = {
    insert: vi.fn(),
    updateStatus: vi.fn(async () => ({})),
    findByProcessorRefundId: vi.fn(async () => null),
    sumSucceededForPayment: vi.fn(),
    // A.11 — `charge.refund.updated` dispatch (processRefundUpdated) locks
    // the refund row by processor id; default `null` → out-of-band path.
    lockForUpdateByProcessorRefundId: vi.fn(async () => null),
    // F5R3 SB-1 (2026-05-16) — webhook recovery now reads succeeded
    // sum to compute parent payment's next status when flipping a
    // pending refund row.
    getRefundContextForUpdate: vi.fn(async () => ({
      pendingCount: 0,
      succeededSumSatang: asSatang(100_000n),
      nextSeq: 1,
    })),
  };
  const processorEventsRepo = {
    insertIfNew: vi.fn(async (_tx: unknown, input: { id: string }) => ({
      inserted: true,
      event: {
        id: input.id,
        tenantId: TENANT_ID,
        eventType: 'payment_intent.succeeded',
        apiVersion: PINNED_API,
        livemode: false,
        processorAccountId: 'acct_test_123',
        receivedAt: new Date(),
        processedAt: null,
        outcome: 'processed' as const,
        payloadSha256: 'x'.repeat(64),
        correlationId: 'corr_1',
      },
    })),
    markProcessed: vi.fn(),
    updateOutcome: vi.fn(),
    findById: vi.fn(),
  };
  const tenantSettingsRepo = {
    getByTenantId: vi.fn(async () => SETTINGS_OK),
    findByProcessorAccountId: vi.fn(),
  };
  const processorGateway = {
    createPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(async () =>
      ok({
        id: 'pi_test_001',
        status: 'succeeded',
        latestChargeId: 'ch_test_001',
        livemode: false,
        lastPaymentErrorCode: null,
        card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
      }),
    ),
    cancelPaymentIntent: vi.fn(),
    createRefund: vi.fn(),
  };
  const invoicingBridge = {
    getInvoiceForPayment: vi.fn(async () =>
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'issued' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    ),
    markPaidFromProcessor: vi.fn(async () => ok(undefined)),
    // A.11 — F4 credit-note bridge used by the shared finaliser on the
    // `charge.refund.updated(succeeded)` path.
    issueCreditNoteFromRefund: vi.fn(async () =>
      ok({ creditNoteId: 'cn_webhook_1', creditNoteNumber: 'CN-2026-0007' }),
    ),
    // tax#5 (B.2) — F4-authoritative invoice-status read used by the shared
    // finaliser on the succeeded path. Present so the real finaliser never
    // throws if a succeeded reconcile is exercised here.
    getInvoiceStatus: vi.fn(async () => ok('credited' as const)),
  };
  const audit = { emit: vi.fn(async () => undefined) };
  const clock = {
    nowIso: () => '2026-05-12T07:00:00.000Z',
    nowMs: () => 1_747_033_200_000,
  };
  return {
    paymentsRepo: paymentsRepo as unknown as ProcessWebhookEventDeps['paymentsRepo'],
    refundsRepo: refundsRepo as unknown as ProcessWebhookEventDeps['refundsRepo'],
    processorEventsRepo: processorEventsRepo as unknown as ProcessWebhookEventDeps['processorEventsRepo'],
    tenantSettingsRepo: tenantSettingsRepo as unknown as ProcessWebhookEventDeps['tenantSettingsRepo'],
    processorGateway: processorGateway as unknown as ProcessWebhookEventDeps['processorGateway'],
    invoicingBridge: invoicingBridge as unknown as ProcessWebhookEventDeps['invoicingBridge'],
    audit: audit as unknown as ProcessWebhookEventDeps['audit'],
    clock,
    // Inert in this unit test: the bridge is mocked, so the flow flag only
    // reaches the (stubbed) inner confirm read (reconciliationPath:true → dormant).
    taxAtPayment: 'off' as const,
    // money-remediation Task 4 — flag OFF preserves the pre-remediation
    // commit-on-bridge-decline behaviour this suite was written against.
    settlementAbort: false,
  };
}

function makeInput(event: VerifiedStripeEvent = makeEvent()) {
  return {
    tenantId: TENANT_ID,
    event,
    payloadSha256: 'a'.repeat(64),
    correlationId: 'corr_1',
    requestId: 'req_1',
  };
}

describe('processWebhookEvent (T056)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path — payment_intent.succeeded dispatches confirmPayment, markProcessed called', async () => {
    const deps = makeDeps();
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    expect(deps.processorEventsRepo.insertIfNew).toHaveBeenCalledTimes(1);
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(1);
    expect(deps.invoicingBridge.markPaidFromProcessor).toHaveBeenCalledTimes(1);
  });

  it('idempotency — duplicate delivery short-circuits (no dispatch, no markProcessed)', async () => {
    const deps = makeDeps();
    (deps.processorEventsRepo.insertIfNew as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      inserted: false,
      event: {
        id: 'evt_test_001',
        tenantId: TENANT_ID,
        eventType: 'payment_intent.succeeded',
        apiVersion: PINNED_API,
        livemode: false,
        processorAccountId: 'acct_test_123',
        receivedAt: new Date(),
        processedAt: new Date(),
        outcome: 'processed',
        payloadSha256: 'x'.repeat(64),
        correlationId: 'corr_1',
      },
    });
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('duplicate');
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    expect(deps.processorEventsRepo.markProcessed).not.toHaveBeenCalled();
  });

  it('payment_intent.payment_failed — dispatches failPayment', async () => {
    const deps = makeDeps();
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_test_001',
        status: 'requires_payment_method',
        latestChargeId: null,
        livemode: false,
        lastPaymentErrorCode: 'card_declined',
        card: null,
      }),
    );
    const event = makeEvent({ type: 'payment_intent.payment_failed' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = auditCalls.find((c) => c[1].eventType === 'payment_failed');
    expect(failedCall).toBeDefined();
    // review-20260428-102639.md W7 closure — payment_failed realigned
    // to 5y (pre-settlement ops). Only payment_succeeded carries the
    // tax-document settlement marker (10y).
    expect(failedCall?.[1].retentionYears).toBe(5);
  });

  it('payment_intent.canceled — dispatches handleCancelEvent', async () => {
    const deps = makeDeps();
    const event = makeEvent({ type: 'payment_intent.canceled' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
  });

  it('charge.refunded with unknown refund id — emits out_of_band_refund_detected', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        refundIds: ['re_unknown_1', 're_unknown_2'],
        amountSatang: asSatang(5_350_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const oobCalls = auditCalls.filter(
      (c) => c[1].eventType === 'out_of_band_refund_detected',
    );
    expect(oobCalls.length).toBe(2);
  });

  it('charge.refunded with known refund id — does NOT emit out_of_band_refund_detected', async () => {
    const deps = makeDeps();
    (deps.refundsRepo.findByProcessorRefundId as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'rfd_123',
      tenantId: TENANT_ID,
      paymentId: asPaymentId('pmt_1'),
      invoiceId: 'inv_1',
      amountSatang: asSatang(100_000n),
      status: 'pending' as const,
      processorRefundId: 're_known_1',
    });
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        refundIds: ['re_known_1'],
        amountSatang: asSatang(100_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) => c[1].eventType === 'out_of_band_refund_detected'),
    ).toBe(false);
    // R5 review-round-3 I-NEW-2 (2026-04-25): pin the I3 contract —
    // the dispatcher MUST forward the affected `invoiceId` from the
    // first DB-existing refund row up onto `outcome.invoiceId` so the
    // route handler can fire surgical revalidatePath. Without this
    // assertion, removing the `refundedInvoiceId = existing.invoiceId`
    // line in process-webhook-event.ts would silently regress to the
    // broad `[invoiceId]` cache-bust pattern and busts every tenant's
    // invoice cache on a single refund event.
    if (result.ok && result.value.kind === 'processed') {
      expect(result.value.invoiceId).toBe('inv_1');
    }
  });

  it('charge.refunded with no refundIds — no audit emitted (empty-array branch)', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        // refundIds omitted → fallback to []
        amountSatang: asSatang(0n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
  });

  // A.11 — charge.refund.updated dispatch branch (processRefundUpdated).
  it('charge.refund.updated unknown refund + no auto-refund → processed (out_of_band; emits the redundant forensic audit, no invoiceId)', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refund.updated',
      dataObject: {
        id: 're_async_unknown_1',
        type: 'refund',
        latestChargeId: 'ch_async_1',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    // out_of_band carries no invoiceId → the dispatcher omits it.
    expect('invoiceId' in result.value).toBe(false);
    // Finding 4 (split ownership) — `charge.refund.updated` emits the
    // `out_of_band_refund_detected` forensic REDUNDANTLY with `charge.refunded`
    // so the 10y money-trail survives either handler failing (deduped on read by
    // processor_refund_id). Only the paging metric stays single-owner on
    // `charge.refunded`.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const oobCall = auditCalls.find(
      (c) => c[1].eventType === 'out_of_band_refund_detected',
    );
    expect(oobCall).toBeDefined();
    expect(oobCall![1].payload.processor_refund_id).toBe('re_async_unknown_1');
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('charge.refund.updated with an already-terminal refund → processed + forwards invoiceId', async () => {
    const deps = makeDeps();
    (
      deps.refundsRepo.lockForUpdateByProcessorRefundId as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'rfd_async_1',
      tenantId: TENANT_ID,
      paymentId: asPaymentId('pmt_1'),
      invoiceId: 'inv_async_1',
      amountSatang: asSatang(50_000n),
      reason: 'requested_by_customer',
      status: 'succeeded',
      processorRefundId: 're_async_1',
      failureReasonCode: null,
      creditNoteId: 'cn_prev',
      initiatedAt: new Date(),
      completedAt: new Date(),
      initiatorUserId: 'usr_1',
      correlationId: 'corr_1',
    });
    const event = makeEvent({
      type: 'charge.refund.updated',
      dataObject: {
        id: 're_async_1',
        type: 'refund',
        latestChargeId: 'ch_async_1',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    // already_finalized carries invoiceId → dispatcher forwards it for
    // surgical revalidatePath (mirrors the charge.refunded I3 contract).
    if (result.value.kind === 'processed') {
      expect(result.value.invoiceId).toBe('inv_async_1');
    }
  });

  it('charge.refund.updated with a bare dataObject (no charge/status/amount) → processed (?? fallbacks)', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refund.updated',
      dataObject: {
        id: 're_async_bare_1',
        type: 'refund',
        // latestChargeId / refundStatus / amountSatang omitted → the
        // dispatcher's `?? null` / `?? 0n` fallbacks fire (null status
        // classifies as pending → out_of_band). Post-Finding 4 the OOB path
        // DEFERS (log + markProcessed, no audit), so this asserts only the
        // processed outcome + ack — no "unknown"-charge audit sentinel exists.
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('charge.refund.updated — withTx rejection returns dispatch_failed (dispatch_threw, no fall-through)', async () => {
    const deps = makeDeps();
    // Let the step-6 idempotency tx commit, then throw on the DISPATCH tx so
    // the failure lands in processRefundUpdated's catch → dispatch_threw.
    rejectSecondTx(deps, new Error('neon reset'));
    const event = makeEvent({
      type: 'charge.refund.updated',
      dataObject: {
        id: 're_async_boom_1',
        type: 'refund',
        latestChargeId: 'ch_async_1',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.kind).toBe('dispatch_threw');
    expect(result.error.eventType).toBe('charge.refund.updated');
    // detail is the Error class name only (no message — PCI SAQ-A).
    expect(result.error.detail).toBe('Error');
  });

  // PR-A follow-up (2026-07-12) — `refund.updated` routes to the SAME
  // `processRefundUpdated` use-case as (deprecated) `charge.refund.updated`.
  // Stripe: "`charge.refund.updated` is only sent for refunds with a
  // corresponding charge; listen to `refund.updated` for updates on all
  // refunds instead" — so a charge-less async (PromptPay) refund's terminal
  // settlement arrives via `refund.updated`. These pin the routing +
  // markProcessed semantics (identical to the charge.refund.updated arm).
  it('refund.updated unknown refund + no auto-refund → processed (out_of_band; routes to processRefundUpdated, emits the redundant forensic audit)', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'refund.updated',
      dataObject: {
        id: 're_async_ru_1',
        type: 'refund',
        latestChargeId: 'ch_async_ru_1',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Routed to processRefundUpdated (NOT the default acknowledged_only branch).
    expect(result.value.kind).toBe('processed');
    expect('invoiceId' in result.value).toBe(false);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const oobCall = auditCalls.find(
      (c) => c[1].eventType === 'out_of_band_refund_detected',
    );
    expect(oobCall).toBeDefined();
    expect(oobCall![1].payload.processor_refund_id).toBe('re_async_ru_1');
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('refund.updated with an already-terminal refund → processed + forwards invoiceId', async () => {
    const deps = makeDeps();
    (
      deps.refundsRepo.lockForUpdateByProcessorRefundId as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'rfd_ru_terminal',
      tenantId: TENANT_ID,
      paymentId: asPaymentId('pmt_1'),
      invoiceId: 'inv_ru_terminal',
      amountSatang: asSatang(50_000n),
      reason: 'requested_by_customer',
      status: 'succeeded',
      processorRefundId: 're_async_ru_2',
      failureReasonCode: null,
      creditNoteId: 'cn_prev',
      initiatedAt: new Date(),
      completedAt: new Date(),
      initiatorUserId: 'usr_1',
      correlationId: 'corr_1',
    });
    const event = makeEvent({
      type: 'refund.updated',
      dataObject: {
        id: 're_async_ru_2',
        type: 'refund',
        latestChargeId: 'ch_async_ru_2',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    if (result.value.kind === 'processed') {
      expect(result.value.invoiceId).toBe('inv_ru_terminal');
    }
  });

  it('refund.updated(failed) on a pending refund → reconciled_failed (routes to the failed branch, no CN)', async () => {
    const deps = makeDeps();
    (
      deps.refundsRepo.lockForUpdateByProcessorRefundId as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      id: 'rfd_ru_pending',
      tenantId: TENANT_ID,
      paymentId: asPaymentId('pmt_1'),
      invoiceId: 'inv_ru_failed',
      amountSatang: asSatang(50_000n),
      reason: 'requested_by_customer',
      status: 'pending',
      processorRefundId: 're_async_ru_3',
      failureReasonCode: null,
      creditNoteId: null,
      initiatedAt: new Date(),
      completedAt: null,
      initiatorUserId: 'usr_1',
      correlationId: 'corr_1',
    });
    const event = makeEvent({
      type: 'refund.updated',
      dataObject: {
        id: 're_async_ru_3',
        type: 'refund',
        latestChargeId: 'ch_async_ru_3',
        refundStatus: 'failed',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    // NO credit note on a failed refund (no §86/4 receipt was reduced).
    expect(deps.invoicingBridge.issueCreditNoteFromRefund).not.toHaveBeenCalled();
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.some((c) => c[1].eventType === 'refund_failed')).toBe(true);
  });

  it('refund.updated — withTx rejection returns dispatch_failed (dispatch_threw, eventType=refund.updated)', async () => {
    const deps = makeDeps();
    rejectSecondTx(deps, new Error('neon reset'));
    const event = makeEvent({
      type: 'refund.updated',
      dataObject: {
        id: 're_async_ru_boom',
        type: 'refund',
        latestChargeId: 'ch_async_ru_boom',
        refundStatus: 'succeeded',
        amountSatang: asSatang(50_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.kind).toBe('dispatch_threw');
    expect(result.error.eventType).toBe('refund.updated');
    expect(result.error.detail).toBe('Error');
  });

  it('CROSS-EVENT idempotency: charge.refund.updated(succeeded) + refund.updated(succeeded) for the SAME refund → credit note issued exactly ONCE', async () => {
    const deps = makeDeps();
    const pendingRow = {
      id: 'rfd_xevent',
      tenantId: TENANT_ID,
      paymentId: asPaymentId('pmt_1'),
      invoiceId: 'inv_xevent',
      amountSatang: asSatang(50_000n),
      reason: 'requested_by_customer',
      status: 'pending' as const,
      processorRefundId: 're_xevent',
      failureReasonCode: null,
      creditNoteId: null,
      // Track B — explicit nulls: the finaliser reads the waiver decision off
      // this row, and `undefined` would route an ordinary refund down the
      // waive arm (skipping credit-note issuance entirely).
      creditNoteWaivedAt: null,
      creditNoteWaiverReason: null,
      initiatedAt: new Date(),
      completedAt: null,
      initiatorUserId: 'usr_1',
      correlationId: 'corr_1',
    };
    // Delivery 1 finds the row pending (finalises → 1 CN); delivery 2 finds it
    // already terminal (the DB flip the 1st delivery committed) → no-op no CN.
    const lock = deps.refundsRepo.lockForUpdateByProcessorRefundId as ReturnType<typeof vi.fn>;
    lock
      .mockResolvedValueOnce(pendingRow)
      .mockResolvedValueOnce({ ...pendingRow, status: 'succeeded', creditNoteId: 'cn_webhook_1' });

    const dataObject = {
      id: 're_xevent',
      type: 'refund' as const,
      latestChargeId: 'ch_xevent',
      refundStatus: 'succeeded',
      amountSatang: asSatang(50_000n),
    };
    // Different event ids (Stripe delivers the two channels as distinct events).
    const first = await processWebhookEvent(
      deps,
      makeInput(makeEvent({ id: 'evt_charge_refund_updated', type: 'charge.refund.updated', dataObject })),
    );
    const second = await processWebhookEvent(
      deps,
      makeInput(makeEvent({ id: 'evt_refund_updated', type: 'refund.updated', dataObject })),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // BOTH deliveries route to processRefundUpdated (2nd is NOT the default
    // acknowledged_only branch) and both forward the invoice id.
    expect(first.value.kind).toBe('processed');
    expect(second.value.kind).toBe('processed');
    if (second.value.kind === 'processed') {
      expect(second.value.invoiceId).toBe('inv_xevent');
    }
    // Exactly ONE credit note across BOTH deliveries: the finaliser's
    // expectedCurrentStatus='pending' guard makes the 2nd (terminal-row)
    // delivery an already_finalized no-op, and the F4 CN is idempotent per
    // (tenant, source_refund_id).
    expect(deps.invoicingBridge.issueCreditNoteFromRefund).toHaveBeenCalledTimes(1);
    // markProcessed is per-event-id → both events acknowledged.
    expect(deps.processorEventsRepo.markProcessed).toHaveBeenCalledTimes(2);
  });

  it('charge.dispute.created — emits dispute_created audit', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.dispute.created',
      dataObject: {
        id: 'ch_disputed',
        type: 'dispute',
        disputeId: 'dp_test_1',
        latestChargeId: 'ch_real_charge_1',
        amountSatang: asSatang(5_350_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.some((c) => c[1].eventType === 'dispute_created')).toBe(true);
    // Bug #6 follow-up (Task C.2 review) — the prose `summary` must cite the
    // real charge id (`latestChargeId`), not the dispute's own `dp_…` id
    // that `dataObject.id` carries on a dispute event. Mirrors the fix
    // already applied to the structured `payload.charge_id` field.
    const disputeCall = auditCalls.find((c) => c[1].eventType === 'dispute_created');
    expect(disputeCall?.[1].summary).toContain('ch_real_charge_1');
    expect(disputeCall?.[1].summary).not.toContain('dp_test_1');
  });

  it('unknown event type — updateOutcome acknowledged_only, markProcessed, no dispatch', async () => {
    const deps = makeDeps();
    const event = makeEvent({ type: 'some.future.event' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('acknowledged_only');
    expect(deps.processorEventsRepo.updateOutcome).toHaveBeenCalledTimes(1);
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  it('confirmPayment auto-refund outcome propagates up as auto_refunded_stale_invoice', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'paid' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({ id: 're_auto', status: 'succeeded', amountSatang: asSatang(5_350_000n) }),
    );
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
  });

  it('sub-use-case failure — dispatch_failed error with eventType', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'some_f4_error', detail: 'x' }),
    );
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.eventType).toBe('payment_intent.succeeded');
  });

  it('fail-payment sub-use-case failure propagates dispatch_failed', async () => {
    const deps = makeDeps();
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const event = makeEvent({ type: 'payment_intent.payment_failed' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
  });

  it('cancel-event illegal_transition from partially_refunded → R4 I-3: ack as processed (NOT dispatch_failed)', async () => {
    // R4 I-3: previously the dispatcher propagated illegal_transition →
    // dispatch_failed → 500 → Stripe 24h retry loop on a permanent
    // mismatch. handleCancelEvent now markProcessed + emits a forensic
    // audit + returns `already_canceled`, which the dispatcher maps to
    // `processed` outcome (Stripe sees 200, retry loop broken).
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, status: 'partially_refunded' as const },
    );
    const event = makeEvent({ type: 'payment_intent.canceled' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
  });

  // ---------------------------------------------------------------------------
  // CR-3 / R3 I-8 — try/catch around the inline withTx blocks (charge.refunded,
  // charge.dispute.created, default unknown event). A tx rejection MUST surface
  // as `dispatch_failed` so the route returns 500 → Stripe retries — NOT fall
  // through to `return ok(outcome)` with `outcome` undefined. The error detail
  // is the Error class name only (never `e.message`) because Stripe error
  // payloads can carry partial API key fragments / internal ids.
  // ---------------------------------------------------------------------------

  // Helper — withTx is called TWICE per dispatch path (once for the step-6
  // idempotency insert, once inside the branch). Make call #1 pass through
  // and call #2 throw, so the rejection lands in the dispatch try/catch we
  // want to exercise.
  function rejectSecondTx(
    deps: ProcessWebhookEventDeps,
    error: unknown,
  ): void {
    const tx = deps.paymentsRepo.withTx as ReturnType<typeof vi.fn>;
    tx.mockReset();
    tx.mockImplementationOnce(async <T>(fn: (t: unknown) => Promise<T>) => fn({}));
    tx.mockImplementationOnce(async () => {
      throw error;
    });
  }

  it('CR-3: charge.refunded — withTx rejection returns dispatch_failed (no fall-through)', async () => {
    const deps = makeDeps();
    class StripeAPIError extends Error {
      constructor() {
        super('audit insert failed: connection lost');
        this.name = 'StripeAPIError';
      }
    }
    rejectSecondTx(deps, new StripeAPIError());
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        refundIds: ['re_test_1'],
        amountSatang: asSatang(5_350_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.eventType).toBe('charge.refunded');
    // detail is the Error class name (no message — PII-safety guarantee).
    expect(result.error.detail).toBe('StripeAPIError');
  });

  it('CR-3: charge.dispute.created — withTx rejection returns dispatch_failed (no fall-through)', async () => {
    const deps = makeDeps();
    rejectSecondTx(deps, new Error('audit table unreachable'));
    const event = makeEvent({
      type: 'charge.dispute.created',
      dataObject: {
        id: 'ch_disputed',
        type: 'dispute',
        disputeId: 'dp_test_1',
        amountSatang: asSatang(5_350_000n),
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.eventType).toBe('charge.dispute.created');
    expect(result.error.detail).toBe('Error');
  });

  it('CR-3 / R3 I-8: unknown event type — withTx rejection returns dispatch_failed', async () => {
    const deps = makeDeps();
    rejectSecondTx(deps, new Error('processor_events INSERT denied by RLS'));
    const event = makeEvent({ type: 'some.future.event' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
    expect(result.error.eventType).toBe('some.future.event');
    expect(result.error.detail).toBe('Error');
  });

  it('charge.refunded with unknown refund id but no amountSatang — `?? 0n` fallback in audit payload', async () => {
    // Branch coverage: line ~327 has `(dataObject.amountSatang ?? 0n).toString()`.
    // Existing tests pass amountSatang explicitly; this one omits it so the
    // nullish-coalesce fallback fires.
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_no_amount',
        type: 'charge',
        refundIds: ['re_unknown_no_amount'],
        // amountSatang intentionally omitted → triggers `?? 0n` fallback
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const oobCall = auditCalls.find(
      (c) => c[1].eventType === 'out_of_band_refund_detected',
    );
    expect(oobCall?.[1].payload.amount_satang).toBe('0');
  });

  it('charge.dispute.created with no disputeId nor amountSatang — both `??` fallbacks fire', async () => {
    // Branch coverage: lines ~363-365 have `disputeId ?? null` and
    // `(amountSatang ?? 0n).toString()`. Cover both fallbacks in one test.
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.dispute.created',
      dataObject: {
        id: 'ch_disputed_minimal',
        type: 'dispute',
        // disputeId + amountSatang both omitted → trigger fallbacks
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const disputeCall = auditCalls.find(
      (c) => c[1].eventType === 'dispute_created',
    );
    expect(disputeCall?.[1].payload.dispute_id).toBeNull();
    expect(disputeCall?.[1].payload.amount_satang).toBe('0');
  });

  it('CR-3 (default branch): non-Error throw maps detail to "unknown" (string-throw safety)', async () => {
    const deps = makeDeps();
    // A rare but real case: postgres-js can reject with a non-Error value
    // (e.g. a pure string). The detail mapper falls back to "unknown" so
    // we never leak the raw payload into the response.
    rejectSecondTx(deps, 'connection terminated unexpectedly: pi_secret_abc123');
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: { id: 'ch_x', type: 'charge', refundIds: [], amountSatang: asSatang(0n) },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toBe('unknown');
  });

  /**
   * money-remediation Task 5 — sub-detail plumbing.
   *
   * Replaces `R2-M1: PERMANENT_SUB_USE_CASE_DETAILS membership snapshot`.
   * The drift that snapshot guarded against is real; it was guarding the
   * wrong artefact. The classification table now lives in
   * `tests/unit/payments/application/webhook-permanence.test.ts`; these
   * tests pin the thing that table cannot see — that the F4 sub-code
   * actually REACHES the classifier instead of being discarded by
   * `subUseCaseErr`, which is the defect Task 5 fixes.
   *
   * These drive the REAL confirm-payment → bridge chain (only the bridge
   * port is stubbed), so a stubbed-out dispatcher cannot fake a pass.
   */
  it('T5: transient F4 sub-code (pdf_render_failed) → subDetail plumbed + transient', async () => {
    const deps = makeDeps();
    // `summariseF4Error` keys the bridge error on `code`; confirm-payment
    // then lifts that code into `ConfirmPaymentError.detail`. This is the
    // exact value that used to be thrown away.
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'pdf_render_failed', detail: 'TypeError' }),
    );
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toBe('bridge_error');
    // Without the plumbing this is `null` and the predicate is fed nothing.
    expect(result.error.subDetail).toBe('pdf_render_failed');
    // Pre-Task-5 this was 'permanent' — a retryable render failure got a
    // 200-ack and the captured money silently stranded (finding F-1).
    expect(result.error.permanence).toBe('transient');
    expect(result.error.retryCeilingExceeded).toBe(false);
  });

  it('T5: permanent F4 sub-code (legacy_no_tin) → subDetail plumbed + permanent', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'legacy_no_tin_event_needs_remediation', detail: 'x' }),
    );
    const result = await processWebhookEvent(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.subDetail).toBe('legacy_no_tin_event_needs_remediation');
    expect(result.error.permanence).toBe('permanent');
  });

  /**
   * The retry ceiling. Task 5 turns transient F4 declines into 500s, and
   * Stripe DISABLES endpoints that fail persistently — so a systemic F4 /
   * Blob outage would otherwise become "webhook endpoint disabled", which
   * is strictly worse than the outage. There is no alerting backend in
   * this repo (no Prometheus/Grafana/PagerDuty, no configured OTel
   * reader), so "land it behind an alert" is unsatisfiable and the
   * ceiling is mandatory, not optional.
   *
   * Mirrors the existing 48h give-up in `confirm-payment.ts`
   * (`STALE_REFUND_GIVE_UP_SECONDS`).
   */
  it('T5: transient past the 48h ceiling escalates to permanent (bounded retry budget)', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'pdf_render_failed', detail: 'TypeError' }),
    );
    // Event created 49h before the stubbed clock.
    const nowSeconds = Math.floor(deps.clock.nowMs() / 1000);
    const event = makeEvent({ createdAtUnixSeconds: nowSeconds - 49 * 60 * 60 });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Classification is unchanged — the escalation is a separate axis, so
    // the forensic row can say "transient class, gave up" rather than
    // lying about F4 being permanently broken.
    expect(result.error.subDetail).toBe('pdf_render_failed');
    expect(result.error.permanence).toBe('permanent');
    expect(result.error.retryCeilingExceeded).toBe(true);
  });

  it('T5: a transient just INSIDE the ceiling still retries', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'pdf_render_failed', detail: 'TypeError' }),
    );
    const nowSeconds = Math.floor(deps.clock.nowMs() / 1000);
    const event = makeEvent({ createdAtUnixSeconds: nowSeconds - 47 * 60 * 60 });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.permanence).toBe('transient');
    expect(result.error.retryCeilingExceeded).toBe(false);
  });

  it('T5: the ceiling never DOWNGRADES an already-permanent classification', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'settings_missing', detail: 'x' }),
    );
    const nowSeconds = Math.floor(deps.clock.nowMs() / 1000);
    const event = makeEvent({ createdAtUnixSeconds: nowSeconds - 49 * 60 * 60 });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.permanence).toBe('permanent');
    // Classified permanent on its own merits — NOT via the ceiling. The
    // forensic must not misattribute it to a give-up.
    expect(result.error.retryCeilingExceeded).toBe(false);
  });

  it('T5: dispatch_threw branches carry a null subDetail (no F4 code exists there)', async () => {
    const deps = makeDeps();
    rejectSecondTx(deps, new Error('neon down'));
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: { id: 'ch_x', type: 'charge', refundIds: [], amountSatang: asSatang(0n) },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('dispatch_threw');
    expect(result.error.subDetail).toBeNull();
    expect(result.error.permanence).toBe('transient');
  });
});
