/**
 * T055 unit tests — initiatePayment use-case.
 *
 * Target: 100% branch coverage (Constitution Principle II; security-
 * critical path). Covers every error branch in the spec § 1 table
 * PLUS the resume-idempotency path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import {
  initiatePayment,
  type InitiatePaymentDeps,
  type InitiatePaymentInput,
} from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';

// GAP-2: metrics module mocked so emission can be asserted in tests.
// Uses `vi.hoisted` to satisfy vitest's mock-before-import constraint.
const metricsMocks = vi.hoisted(() => ({
  initiateDurationMs: vi.fn(),
  qrLoadRetriesExhausted: vi.fn(),
  crossMethodCancelDurationMs: vi.fn(),
  initiateCount: vi.fn(),
  succeededCount: vi.fn(),
  failedCount: vi.fn(),
  autoRefundedStaleCount: vi.fn(),
  refundInitiateCount: vi.fn(),
  refundSucceededCount: vi.fn(),
  refundFailedCount: vi.fn(),
  webhookReceiveCount: vi.fn(),
  webhookDuplicateIgnored: vi.fn(),
  webhookSignatureRejected: vi.fn(),
  webhookApiVersionMismatch: vi.fn(),
  outOfBandRefundRejected: vi.fn(),
  stalePendingCount: vi.fn(),
  inviteToPaymentFunnelStep: vi.fn(),
}));
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: metricsMocks,
  };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TENANT_ID = 'tnt_abc';
const INVOICE_ID = 'inv_01JABCDEFGHIJKLMNOPQRSTUV';
const ACTOR_USER_ID = 'usr_01JABCDE';
const MEMBER_ID = 'mem_01JABCDE';

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

const INVOICE_DTO = {
  id: INVOICE_ID,
  status: 'issued' as const,
  totalSatang: asSatang(5_350_000n),
  memberId: MEMBER_ID,
  tenantId: TENANT_ID,
};

function makeInput(overrides: Partial<InitiatePaymentInput> = {}): InitiatePaymentInput {
  return {
    tenantId: TENANT_ID,
    actorUserId: ACTOR_USER_ID,
    actorMemberId: MEMBER_ID,
    actorEmail: 'member@swecham.test',
    invoiceId: INVOICE_ID,
    method: 'card',
    correlationId: 'corr_1',
    requestId: 'req_1',
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<InitiatePaymentDeps> = {},
): InitiatePaymentDeps {
  const audit = { emit: vi.fn(async () => undefined) };
  const paymentsRepo = {
    withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({})),
    acquireInitiateLock: vi.fn(async () => undefined),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(async (_tx: unknown, input: { id: string }) => ({
      id: asPaymentId(input.id),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card' as const,
      status: 'pending' as const,
      amountSatang: asSatang(5_350_000n),
      currency: 'THB' as const,
      processorPaymentIntentId: 'pi_test_new',
      processorChargeId: null,
      processorEnvironment: 'test' as const,
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T07:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_1',
    })),
    updateStatus: vi.fn(),
    findPendingByInvoiceAndActor: vi.fn(async () => null),
    listSiblingStatusesForInvariant: vi.fn(async () => []),
    nextAttemptSeq: vi.fn(async () => 1),
  };
  const tenantSettingsRepo = {
    getByTenantId: vi.fn(async () => SETTINGS_OK),
    findByProcessorAccountId: vi.fn(),
  };
  const processorGateway = {
    createPaymentIntent: vi.fn(async () =>
      ok({
        id: 'pi_test_new',
        clientSecret: 'pi_test_new_secret_abc',
        status: 'requires_payment_method',
        livemode: false,
        promptpayQrSvgUrl: null,
      }),
    ),
    retrievePaymentIntent: vi.fn(async () =>
      ok({
        id: 'pi_existing',
        status: 'requires_payment_method',
        // Resume path reads clientSecret from retrievePaymentIntent
        // (not a second createPaymentIntent). Default mock returns
        // non-null so happy-path resume tests don't fall into the
        // null-clientSecret processor_unavailable branch.
        clientSecret: 'pi_existing_secret_resume',
        latestChargeId: null,
        livemode: false,
        lastPaymentErrorCode: null,
        card: null,
        promptpayQrSvgUrl: null,
      }),
    ),
    cancelPaymentIntent: vi.fn(async () => ok(undefined)),
    createRefund: vi.fn(),
  };
  const invoicingBridge = {
    getInvoiceForPayment: vi.fn(async () => ok(INVOICE_DTO)),
    markPaidFromProcessor: vi.fn(),
  };
  const clock = {
    nowIso: () => '2026-05-12T07:00:00.000Z',
    nowMs: () => 1_747_033_200_000,
  };
  const generatePaymentId = vi.fn(() => asPaymentId('pmt_01JABCDE_TEST'));

  return {
    paymentsRepo: paymentsRepo as unknown as InitiatePaymentDeps['paymentsRepo'],
    tenantSettingsRepo: tenantSettingsRepo as unknown as InitiatePaymentDeps['tenantSettingsRepo'],
    processorGateway: processorGateway as unknown as InitiatePaymentDeps['processorGateway'],
    invoicingBridge: invoicingBridge as unknown as InitiatePaymentDeps['invoicingBridge'],
    audit: audit as unknown as InitiatePaymentDeps['audit'],
    clock,
    generatePaymentId,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('initiatePayment (T055)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path — inserts new payment, creates intent, emits payment_initiated', async () => {
    const deps = makeDeps();
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumed).toBe(false);
    expect(result.value.clientSecret).toBe('pi_test_new_secret_abc');
    expect(result.value.publishableKey).toBe('pk_test_abc');
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(auditCall?.[1].eventType).toBe('payment_initiated');
    // Staff-review R2 R005 (2026-04-28): pin retentionYears at the unit
    // boundary so a regression on `F5_AUDIT_RETENTION_YEARS['payment_initiated']`
    // does not pass green silently. review-20260428-102639.md W7 closure
    // realigned to 5y (pre-settlement ops) — only `payment_succeeded`
    // remains at 10y as the settlement-record event.
    expect(auditCall?.[1].retentionYears).toBe(5);
    // Staff-review R2 R014 (2026-04-28): pin idempotency-key shape
    // `inv-{invoiceId}-attempt-{n}` at the unit layer; integration mock
    // already asserts the exact concrete value.
    const stripeCall = (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(stripeCall?.[0]?.idempotencyKey).toMatch(/^inv-.+-attempt-\d+$/);
    // GAP-2: A-07 metric MUST be emitted on the success path with
    // the bounded `method` label.
    expect(metricsMocks.initiateDurationMs).toHaveBeenCalledTimes(1);
    expect(metricsMocks.initiateDurationMs).toHaveBeenCalledWith(
      'card',
      expect.any(Number),
      // Staff-review R2 R018 (2026-04-28): tenant label now threaded.
      expect.any(String),
    );
  });

  it('GAP-2: initiate latency metric fires even on early-exit error paths (no Stripe call)', async () => {
    // SUG-2 invariant: histogram MUST cover all exit paths so p95
    // reflects real user experience, not just Stripe-roundtrip code paths.
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    expect(metricsMocks.initiateDurationMs).toHaveBeenCalledTimes(1);
    expect(metricsMocks.initiateDurationMs).toHaveBeenCalledWith(
      'card',
      expect.any(Number),
      // Staff-review R2 R018 (2026-04-28): tenant label now threaded.
      expect.any(String),
    );
  });

  it('GAP-2: cross-method-cancel duration metric fires with correct outcome label per branch', async () => {
    // Outcome labels expected for crossMethodCancelDurationMs:
    //   'ok'        — Stripe confirmed cancel
    //   'permanent' — Stripe rejected (e.g. already-canceled / not-found)
    //   'retryable' — transient Stripe error (R-01 path)
    // Asserted across all 3 in their respective dedicated tests below;
    // this one pins the happy-path label.
    const existingCard: Payment = {
      id: asPaymentId('pmt_metric_observe'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_metric_observe',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr-metric',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingCard,
    );
    (deps.paymentsRepo.nextAttemptSeq as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_promptpay_new',
        clientSecret: 'pi_promptpay_new_secret',
        status: 'requires_action',
        livemode: false,
        promptpayQrSvgUrl: 'https://qr.stripe.com/v1/x.svg',
      }),
    );

    await initiatePayment(deps, makeInput({ method: 'promptpay' }));
    expect(metricsMocks.crossMethodCancelDurationMs).toHaveBeenCalledTimes(1);
    expect(metricsMocks.crossMethodCancelDurationMs).toHaveBeenCalledWith(
      'ok',
      expect.any(Number),
    );
    // Both metrics fire in the cross-method path
    expect(metricsMocks.initiateDurationMs).toHaveBeenCalledTimes(1);
  });

  // PCI SAQ-A invariant (FR-016) — the inserted payment
  // row MUST never carry any field that resembles a Primary Account
  // Number (13–19 contiguous digits). The payment domain shape only
  // accepts brand/last4/expMonth/expYear; this test is the regression
  // guard that fails LOUDLY if a future contributor widens the schema
  // or use-case input to accept a raw PAN through the back door.
  it('PCI SAQ-A: never persists a PAN-shaped value on the payment row', async () => {
    const deps = makeDeps();
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(true);

    const insertCall = (deps.paymentsRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(insertCall).toBeDefined();
    const inserted = insertCall![0] as Record<string, unknown>;

    // No field should match a 13–19-digit PAN.
    const PAN_REGEX = /\b\d{13,19}\b/;
    for (const [key, value] of Object.entries(inserted)) {
      if (typeof value !== 'string') continue;
      // last4 is allow-listed (4 digits) — never matches PAN_REGEX.
      expect(PAN_REGEX.test(value), `Field ${key} contained PAN-shaped value`).toBe(false);
    }

    // Forbidden field names — never present on the insert payload.
    const FORBIDDEN_FIELDS = ['pan', 'card_number', 'cardNumber', 'cvv', 'cvc', 'card_cvc', 'card_cvv'];
    for (const field of FORBIDDEN_FIELDS) {
      expect(inserted).not.toHaveProperty(field);
    }
  });

  it('resume path — returns existing pending WITHOUT re-auditing', async () => {
    const existing: Payment = {
      id: asPaymentId('pmt_existing'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existing,
    );
    // Resume reads via `retrievePaymentIntent` (default mock returns
    // a non-null clientSecret); no `createPaymentIntent` call should
    // be made on the resume path.

    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumed).toBe(true);
    expect(result.value.payment.id).toBe(existing.id);
    expect(deps.audit.emit).not.toHaveBeenCalled(); // no re-audit on resume
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
    // Resume MUST go through retrieve, not create
    expect(deps.processorGateway.retrievePaymentIntent).toHaveBeenCalledWith(
      'pi_existing',
      'acct_test_123',
    );
    expect(deps.processorGateway.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('resume path — retrievePaymentIntent failure surfaces processor_unavailable', async () => {
    const existing: Payment = {
      id: asPaymentId('pmt_existing'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existing,
    );
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'stripe_down' }),
    );

    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
  });

  it('resume path — retrievePaymentIntent returns null clientSecret surfaces processor_unavailable', async () => {
    // Group E1 (2026-04-24, Architect D-01) — previously this test
    // asserted that a second `createPaymentIntent` call failure (the
    // old workaround for recovering clientSecret) surfaced as
    // processor_unavailable. The workaround is removed: resume now
    // reads clientSecret directly from retrievePaymentIntent. A null
    // clientSecret (Stripe returns null for intents in terminal
    // states) is the new equivalent failure mode and must still
    // surface as processor_unavailable so the caller retries after
    // reconciliation.
    const existing: Payment = {
      id: asPaymentId('pmt_existing'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existing,
    );
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_existing',
        status: 'succeeded',
        clientSecret: null,
        latestChargeId: 'ch_terminal',
        livemode: false,
        lastPaymentErrorCode: null,
        card: null,
      }),
    );

    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    if (result.error.code !== 'processor_unavailable') return;
    expect(result.error.reason).toBe('retrieved_client_secret_null');
  });

  it('cross-method resume skip — pending card PI does NOT resume when promptpay requested', async () => {
    // When a member opens the card tab (creating a pending card PI)
    // then switches to the PromptPay tab, the use-case must NOT hand
    // back the card PI's clientSecret with `promptpayQrSvgUrl=null`.
    // It must cancel the stale-method PI and create a fresh
    // PromptPay PaymentIntent so the browser receives a real QR.
    const existingCard: Payment = {
      id: asPaymentId('pmt_existing_card'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card', // <-- pending row is for card
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing_card',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingCard,
    );
    (deps.paymentsRepo.nextAttemptSeq as ReturnType<typeof vi.fn>).mockResolvedValueOnce(2);
    (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_promptpay_new',
        clientSecret: 'pi_promptpay_new_secret_xyz',
        status: 'requires_action',
        livemode: false,
        promptpayQrSvgUrl: 'https://qr.stripe.com/v1/promptpay_new.svg',
      }),
    );

    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Asserts the cross-method-resume skip behaviour:
    expect(result.value.resumed).toBe(false);
    expect(result.value.paymentIntentId).toBe('pi_promptpay_new');
    expect(result.value.promptpayQrSvgUrl).toBe(
      'https://qr.stripe.com/v1/promptpay_new.svg',
    );
    expect(result.value.promptpayQrExpirySeconds).toBe(900);
    // First-attempt-flow side effects DID happen (resume side effects DID NOT):
    expect(deps.paymentsRepo.insert).toHaveBeenCalledTimes(1);
    expect(deps.audit.emit).toHaveBeenCalled();
    // retrievePaymentIntent (resume-only call) MUST NOT have been called
    // — that's how we distinguish skip-resume vs took-resume.
    expect(deps.processorGateway.retrievePaymentIntent).not.toHaveBeenCalled();
    // The stale card PI MUST have been canceled both on Stripe AND
    // in our DB row, with a `payment_method_switched` audit emitted
    // (distinct from `payment_canceled` which means user-abandon).
    expect(deps.processorGateway.cancelPaymentIntent).toHaveBeenCalledWith(
      'pi_existing_card',
      'acct_test_123',
    );
    expect(deps.paymentsRepo.updateStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: existingCard.id,
        nextStatus: 'canceled',
      }),
    );
    // Two audit emits expected: payment_method_switched (cross-method
    // skip) + payment_initiated (new PI). Order matters — switch first.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.length).toBeGreaterThanOrEqual(2);
    expect(auditCalls[0]?.[1]).toMatchObject({
      eventType: 'payment_method_switched',
      payload: expect.objectContaining({
        attempt_seq: existingCard.attemptSeq,
        cancel_outcome: 'stripe_confirmed',
        previous_method: 'card',
        new_method: 'promptpay',
      }),
    });
  });

  it('same-method resume — pending promptpay PI resumes when promptpay requested', async () => {
    // Counterpart to the cross-method-skip test: when methods match,
    // the resume branch DOES fire (no INSERT, no audit re-emit).
    const existingPromptpay: Payment = {
      id: asPaymentId('pmt_existing_promptpay'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'promptpay',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing_promptpay',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingPromptpay,
    );

    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumed).toBe(true);
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
    expect(deps.processorGateway.retrievePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('cross-method skip — Stripe reports PI already succeeded → returns processor_unavailable WITHOUT marking DB canceled (financial integrity)', async () => {
    // Race window: user clicks card → enters card details → 3DS
    // resolves → Stripe PI flips to `succeeded` → user switches to
    // PromptPay tab BEFORE the inbound webhook has updated our DB
    // row. Cross-method skip would normally cancel the stale row,
    // but Stripe rejects the cancel with
    // `payment_intent_already_succeeded`. We MUST NOT mark the DB
    // row `canceled` in that window — the customer was charged.
    const existingCard: Payment = {
      id: asPaymentId('pmt_existing_card_succeeded'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing_card',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingCard,
    );
    // Stripe rejects the cancel because the PI just succeeded.
    (deps.processorGateway.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({
        kind: 'permanent',
        code: 'payment_intent_already_succeeded',
        reason: 'PI is succeeded; cannot be canceled',
      }),
    );

    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    if (result.error.code !== 'processor_unavailable') return;
    expect(result.error.kind).toBe('permanent');
    expect(result.error.reason).toBe('cross_method_pi_already_succeeded');

    // Critical: DB row MUST NOT have been marked canceled
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    // No new PI was created either — caller must reconcile via webhook
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
    expect(deps.processorGateway.createPaymentIntent).not.toHaveBeenCalled();
    // No payment_method_switched audit emitted (would be misleading
    // — Stripe says succeeded, no method switch occurred)
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const switchEmits = auditCalls.filter(
      (call) => call[1]?.eventType === 'payment_method_switched',
    );
    expect(switchEmits.length).toBe(0);
  });

  it('cross-method skip — Stripe cancel returns RETRYABLE error → returns processor_unavailable WITHOUT marking DB canceled (R-01: prevents DB-canceled / Stripe-pending drift)', async () => {
    // Without this guard, a transient Stripe error during cancel
    // (network timeout / rate-limit) would leave the DB row marked
    // `canceled` while the Stripe PI may STILL be `pending` — the
    // sweep cron is NOT designed to detect this drift direction.
    // The customer's old card PI could later auto-confirm and
    // charge them with no DB row to reconcile.
    const existingCard: Payment = {
      id: asPaymentId('pmt_existing_card_retryable'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing_retryable',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 1,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingCard,
    );
    // Stripe transient error during cancel.
    (deps.processorGateway.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'network timeout' }),
    );

    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    if (result.error.code !== 'processor_unavailable') return;
    expect(result.error.kind).toBe('retryable');
    expect(result.error.reason).toBe('cross_method_cancel_retryable');

    // Critical: DB row MUST NOT have been marked canceled
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    // No new PI was created either — caller must retry from a clean slate
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
    expect(deps.processorGateway.createPaymentIntent).not.toHaveBeenCalled();
    // No audit emitted (would be misleading — switch did not complete)
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const switchEmits = auditCalls.filter(
      (call) => call[1]?.eventType === 'payment_method_switched',
    );
    expect(switchEmits.length).toBe(0);
  });

  it('cross-method skip — Stripe cancel returns OTHER permanent error (already-canceled) → marks DB canceled with cancel_outcome=stripe_error_bypassed (T-P4-05)', async () => {
    // Permanent non-succeeded errors (already-canceled, not-found,
    // etc.) leave Stripe in a terminal-non-succeeded state from our
    // perspective, so the local row CAN safely be marked canceled.
    // The audit's `cancel_outcome` field distinguishes this from the
    // happy "stripe_confirmed" path for forensic clarity.
    const existingCard: Payment = {
      id: asPaymentId('pmt_existing_card_already_canceled'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: asSatang(5_350_000n),
      currency: 'THB',
      processorPaymentIntentId: 'pi_existing_already_canceled',
      processorChargeId: null,
      processorEnvironment: 'test',
      attemptSeq: 3,
      card: null,
      failureReasonCode: null,
      initiatedAt: new Date('2026-05-12T06:00:00Z'),
      completedAt: null,
      actorUserId: ACTOR_USER_ID,
      correlationId: 'corr_prev',
    };
    const deps = makeDeps();
    (deps.paymentsRepo.findPendingByInvoiceAndActor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      existingCard,
    );
    (deps.processorGateway.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({
        kind: 'permanent',
        code: 'resource_missing',
        reason: 'No such payment_intent',
      }),
    );
    (deps.paymentsRepo.nextAttemptSeq as ReturnType<typeof vi.fn>).mockResolvedValueOnce(4);
    (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_promptpay_new',
        clientSecret: 'pi_promptpay_new_secret',
        status: 'requires_action',
        livemode: false,
        promptpayQrSvgUrl: 'https://qr.stripe.com/v1/x.svg',
      }),
    );

    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(deps.paymentsRepo.updateStatus).toHaveBeenCalled();
    expect(deps.paymentsRepo.insert).toHaveBeenCalledTimes(1);
    // Audit MUST carry the bypassed-error discriminator + attempt_seq
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const switchEmit = auditCalls.find(
      (call) => call[1]?.eventType === 'payment_method_switched',
    );
    expect(switchEmit).toBeDefined();
    expect(switchEmit?.[1]?.payload).toMatchObject({
      attempt_seq: 3,
      cancel_outcome: 'stripe_error_bypassed',
    });
  });

  it('tenant_settings missing — tenant_settings_incomplete', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tenant_settings_incomplete');
  });

  it('online_payment_enabled=false — online_payment_disabled', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      onlinePaymentEnabled: false,
    });
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('online_payment_disabled');
  });

  it('missing publishable key — tenant_settings_incomplete', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      processorPublishableKey: '',
    });
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tenant_settings_incomplete');
    if (result.error.code !== 'tenant_settings_incomplete') return;
    // Audit 2026-04-25 finding #2: shape changed from `missing: [reason]`
    // (always single-element array) to scalar `reason`.
    expect(result.error.reason).toBe('missing_publishable_key');
  });

  it('method not enabled — method_not_enabled', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      enabledMethods: ['card'], // promptpay disabled
    });
    const result = await initiatePayment(deps, makeInput({ method: 'promptpay' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('method_not_enabled');
  });

  it('invoice not found — invoice_not_found + payment_cross_tenant_probe (R2 CR-5)', async () => {
    // R2 fix (2026-04-27): F4's RLS+FORCE returns `not_found` for
    // BOTH "invoice doesn't exist" and "invoice exists in another
    // tenant" — Constitution Principle I sub-clause: ambiguous-by-
    // design. The use-case now emits `payment_cross_tenant_probe` on
    // both `not_found` and `forbidden` outcomes so the live cross-
    // tenant integration test (cross-tenant-probe.test.ts) gets a
    // forensic audit row even when RLS produces the not_found shape.
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_found');
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(auditCall?.[0]).toBeNull();
    expect(auditCall?.[1].eventType).toBe('payment_cross_tenant_probe');
    expect(auditCall?.[1].payload.bridge_outcome).toBe('not_found');
  });

  it('invoice forbidden — forbidden_invoice + payment_cross_tenant_probe emitted', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'forbidden' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('forbidden_invoice');
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const auditCall = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(auditCall?.[0]).toBeNull(); // best-effort, no tx
    expect(auditCall?.[1].eventType).toBe('payment_cross_tenant_probe');
  });

  it('invoice not payable — invoice_not_payable with currentStatus', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_payable', status: 'paid' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_payable');
    if (result.error.code !== 'invoice_not_payable') return;
    expect(result.error.currentStatus).toBe('paid');
  });

  // 054-event-fee-invoices (Task 8) — F5 access model for NON-member event
  // invoices. The F4 bridge surfaces `not_payable` for a null-member event
  // invoice (its memberId can't bind a `payments.member_id NOT NULL` row), so
  // the member-portal self-pay path here MUST reject with
  // `invoice_not_payable` and NEVER reach `paymentsRepo.insert` (no null
  // memberId persisted, no createPaymentIntent burned). This pins the decision
  // that non-member event invoices are not member-self-payable.
  it('non-member event invoice (bridge not_payable, status=issued) — invoice_not_payable, no insert / no Stripe call', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_payable', status: 'issued' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_payable');
    if (result.error.code !== 'invoice_not_payable') return;
    expect(result.error.currentStatus).toBe('issued');
    // No DB write + no processor round-trip on the non-payable path.
    expect(deps.processorGateway.createPaymentIntent).not.toHaveBeenCalled();
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
  });

  // W1 (audit 2026-04-25 follow-up): F4's `getInvoiceForPayment` returns
  // `ok({status: 'paid'})` for already-settled invoices (it only hard-
  // rejects on `null`/zero `total`). Without an explicit gate in the
  // use-case, we'd happily createPaymentIntent for a paid invoice → user
  // sees a card form they cannot use. This test pins the explicit reject.
  it('invoice already paid (bridge returns ok status=paid) — invoice_not_payable', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_paid',
        status: 'paid' as const,
        totalSatang: asSatang(535_000n),
        memberId: 'mem_test',
        tenantId: 'tnt_abc',
      }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_payable');
    if (result.error.code !== 'invoice_not_payable') return;
    expect(result.error.currentStatus).toBe('paid');
    // No PI should have been created.
    expect(deps.processorGateway.createPaymentIntent).not.toHaveBeenCalled();
  });

  // W2 (audit 2026-04-25 follow-up): the `idempotencyKeyFactory` Strategy
  // port replaces the prior `devSaltIdempotencyKey: boolean` flag (Clean
  // Architecture polish — Application doesn't need to know dev-vs-prod).
  // Default = identity; dev composition wires a timestamp salt to bypass
  // Stripe's 24-hour idempotency-key cache during repeat manual testing.
  it('idempotencyKeyFactory default (omitted) — uses canonical base key', async () => {
    const deps = makeDeps();
    await initiatePayment(deps, makeInput());
    const createCall = (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(createCall?.idempotencyKey).toMatch(/^inv-[a-zA-Z0-9_-]+-attempt-\d+$/);
    expect(createCall?.idempotencyKey).not.toMatch(/-d-\d+/);
  });

  it('idempotencyKeyFactory injected — wraps base key with dev salt', async () => {
    const deps = makeDeps();
    const wrapped = {
      ...deps,
      idempotencyKeyFactory: (base: string) => `${base}-d-1234567890`,
    };
    await initiatePayment(wrapped, makeInput());
    const createCall = (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(createCall?.idempotencyKey).toMatch(/^inv-[a-zA-Z0-9_-]+-attempt-\d+-d-1234567890$/);
  });

  it('createPaymentIntent failure — processor_unavailable (no row inserted)', async () => {
    const deps = makeDeps();
    (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('key_environment_mismatch — tenant_settings_incomplete (not online_payment_disabled)', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      processorEnvironment: 'live',
      processorPublishableKey: 'pk_test_xxx', // live env + test key
    });
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tenant_settings_incomplete');
  });

  it('missing processor_account_id — tenant_settings_incomplete', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      processorAccountId: '',
    });
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tenant_settings_incomplete');
  });

  it('no enabled methods — tenant_settings_incomplete', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...SETTINGS_OK,
      enabledMethods: [],
    });
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('tenant_settings_incomplete');
  });
});
