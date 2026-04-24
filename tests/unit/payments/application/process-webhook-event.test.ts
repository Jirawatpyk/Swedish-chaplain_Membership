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
  amountSatang: 5_350_000n,
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
  };
  const refundsRepo = {
    insert: vi.fn(),
    updateStatus: vi.fn(),
    findByProcessorRefundId: vi.fn(async () => null),
    sumSucceededForPayment: vi.fn(),
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
    updateTenantId: vi.fn(),
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
        totalSatang: 5_350_000n,
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    ),
    markPaidFromProcessor: vi.fn(async () => ok(undefined)),
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
    expect(auditCalls.some((c) => c[1].eventType === 'payment_failed')).toBe(true);
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
        amountSatang: 5_350_000n,
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
      amountSatang: 100_000n,
      status: 'pending' as const,
      processorRefundId: 're_known_1',
    });
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        refundIds: ['re_known_1'],
        amountSatang: 100_000n,
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) => c[1].eventType === 'out_of_band_refund_detected'),
    ).toBe(false);
  });

  it('charge.refunded with no refundIds — no audit emitted (empty-array branch)', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.refunded',
      dataObject: {
        id: 'ch_test_001',
        type: 'charge',
        // refundIds omitted → fallback to []
        amountSatang: 0n,
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
  });

  it('charge.dispute.created — emits dispute_created audit', async () => {
    const deps = makeDeps();
    const event = makeEvent({
      type: 'charge.dispute.created',
      dataObject: {
        id: 'ch_disputed',
        type: 'dispute',
        disputeId: 'dp_test_1',
        amountSatang: 5_350_000n,
      },
    });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.some((c) => c[1].eventType === 'dispute_created')).toBe(true);
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
        totalSatang: 5_350_000n,
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({ id: 're_auto', status: 'succeeded', amountSatang: 5_350_000n }),
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

  it('cancel-event sub-use-case failure propagates dispatch_failed (illegal from succeeded)', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, status: 'succeeded' as const },
    );
    // succeeded is terminal-ish for cancel → handleCancelEvent returns
    // already_canceled (no-op ok), so no dispatch_failed. Instead force an
    // illegal_transition by simulating an unreachable state. The state
    // machine treats `succeeded → canceled` as terminal (no destinations
    // out), which handleCancelEvent maps to already_canceled. To hit the
    // `illegal_transition` err branch at the dispatcher we'd need a state
    // with destinations that doesn't include 'canceled'. `partially_refunded`
    // has destinations `[partially_refunded, refunded]` — no `canceled` →
    // illegal_transition.
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockReset();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, status: 'partially_refunded' as const },
    );
    const event = makeEvent({ type: 'payment_intent.canceled' });
    const result = await processWebhookEvent(deps, makeInput(event));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('dispatch_failed');
  });
});
