/**
 * T055 unit tests — initiatePayment use-case.
 *
 * Target: 100% branch coverage (Constitution Principle II; security-
 * critical path). Covers every error branch in the spec § 1 table
 * PLUS the resume-idempotency path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  initiatePayment,
  type InitiatePaymentDeps,
  type InitiatePaymentInput,
} from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';

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
  totalSatang: 5_350_000n,
  memberId: MEMBER_ID,
  tenantId: TENANT_ID,
};

function makeInput(overrides: Partial<InitiatePaymentInput> = {}): InitiatePaymentInput {
  return {
    tenantId: TENANT_ID,
    actorUserId: ACTOR_USER_ID,
    actorMemberId: MEMBER_ID,
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
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(async (_tx: unknown, input: { id: string }) => ({
      id: asPaymentId(input.id),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card' as const,
      status: 'pending' as const,
      amountSatang: 5_350_000n,
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
        // Group E1 (2026-04-24) — resume path now reads clientSecret
        // directly from retrievePaymentIntent (Architect D-01). Default
        // mock returns a non-null value so the resume happy-path test
        // exits `ok` instead of falling into the null-clientSecret
        // processor_unavailable branch.
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
      amountSatang: 5_350_000n,
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
    (deps.processorGateway.createPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'pi_existing',
        clientSecret: 'pi_existing_secret_resume',
        status: 'requires_payment_method',
        livemode: false,
        promptpayQrSvgUrl: null,
      }),
    );

    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.resumed).toBe(true);
    expect(result.value.payment.id).toBe(existing.id);
    expect(deps.audit.emit).not.toHaveBeenCalled(); // no re-audit on resume
    expect(deps.paymentsRepo.insert).not.toHaveBeenCalled();
  });

  it('resume path — retrievePaymentIntent failure surfaces processor_unavailable', async () => {
    const existing: Payment = {
      id: asPaymentId('pmt_existing'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card',
      status: 'pending',
      amountSatang: 5_350_000n,
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
      amountSatang: 5_350_000n,
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

  it('cross-method resume skip — pending card PI does NOT resume when promptpay requested (Verify-fix F1, 2026-04-26)', async () => {
    // Phase 4 verify-fix F1 / spec § Edge Cases: when a member opens
    // the card tab (creates a pending card PI), then switches to the
    // PromptPay tab, the use-case must NOT hand back the card PI's
    // clientSecret with `promptpayQrSvgUrl=null`. It must skip the
    // resume branch and create a fresh promptpay PaymentIntent so the
    // browser receives a real QR.
    const existingCard: Payment = {
      id: asPaymentId('pmt_existing_card'),
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      memberId: MEMBER_ID,
      method: 'card', // <-- pending row is for card
      status: 'pending',
      amountSatang: 5_350_000n,
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
    // C3 fix (2026-04-26): the stale card PI MUST have been canceled
    // both on Stripe AND in our DB row, with a `payment_canceled`
    // audit emitted — no orphan PI lingering until the T101 cron.
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
    // Two audit emits expected: payment_canceled (cross-method skip)
    // + payment_initiated (new PI). Order matters — cancel first.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(auditCalls.length).toBeGreaterThanOrEqual(2);
    expect(auditCalls[0]?.[1]).toMatchObject({ eventType: 'payment_canceled' });
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
      amountSatang: 5_350_000n,
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

  it('invoice not found — invoice_not_found (no cross-tenant audit)', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );
    const result = await initiatePayment(deps, makeInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_not_found');
    expect(deps.audit.emit).not.toHaveBeenCalled();
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
        totalSatang: 535_000n,
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
