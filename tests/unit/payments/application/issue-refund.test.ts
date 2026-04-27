/**
 * T108 — issueRefund use-case unit tests.
 *
 * Coverage policy: Principle II — 100% branch coverage. Every error
 * code in `IssueRefundError` is exercised + each happy-path
 * post-refund payment status (partially_refunded / refunded) is
 * pinned.
 *
 * Pure unit — no DB, no Stripe SDK. Mocks every dep via the port
 * interfaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import { issueRefund } from '@/modules/payments/application/use-cases/issue-refund';
import type { IssueRefundDeps, IssueRefundInput } from '@/modules/payments/application/use-cases/issue-refund';
import type { Payment } from '@/modules/payments/domain/payment';
import { asPaymentId } from '@/modules/payments/domain/payment';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Valid Crockford base32 — no I, L, O, U characters (excluded by RE_ULID_LIKE).
const PAYMENT_ID = 'pmt_01JABCDEFGHJKMNPQRSTVWXYZ';
const TENANT_ID = 'tnt-test-1';
const ACTOR_ID = 'user-admin-1';
const CORR_ID = 'corr-rfnd-1';
const NOW_MS = Date.parse('2026-05-15T03:14:22.456Z');

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: asPaymentId(PAYMENT_ID),
    tenantId: TENANT_ID,
    invoiceId: 'inv-1',
    memberId: 'mbr-1',
    method: 'card',
    status: 'succeeded',
    amountSatang: 5_350_000n,
    currency: 'THB',
    processorPaymentIntentId: 'pi_test_xxx',
    processorChargeId: 'ch_test_xxx',
    processorEnvironment: 'test',
    attemptSeq: 1,
    card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
    failureReasonCode: null,
    initiatedAt: new Date(NOW_MS - 60_000),
    completedAt: new Date(NOW_MS - 30_000),
    actorUserId: 'user-member-1',
    correlationId: 'corr-pay-1',
    ...overrides,
  };
}

function baseInput(overrides: Partial<IssueRefundInput> = {}): IssueRefundInput {
  return {
    tenantId: TENANT_ID,
    paymentId: PAYMENT_ID,
    amountSatang: 350_000n,
    reason: 'Tier downgrade — partial refund',
    actorUserId: ACTOR_ID,
    correlationId: CORR_ID,
    requestId: 'req-rfnd-1',
    ...overrides,
  };
}

// Build a deps graph where every method is a vi.fn — tests override
// the ones they exercise. `withTx` runs the callback with a sentinel
// tx token so we can assert it threads through.
function makeDeps(overrides: Partial<IssueRefundDeps> = {}): IssueRefundDeps {
  const tx = Symbol('tx');
  const paymentsRepo = {
    withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    lockForUpdate: vi.fn(async () => makePayment()),
    lockForUpdateByPaymentIntentId: vi.fn(),
    insert: vi.fn(),
    updateStatus: vi.fn(async () => makePayment({ status: 'partially_refunded' })),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(),
    nextAttemptSeq: vi.fn(),
    listSucceededMethodByInvoiceIds: vi.fn(),
    listInvoiceActivity: vi.fn(),
  };
  const refundsRepo = {
    insert: vi.fn(async () => ({
      id: 'rfnd_01J',
      tenantId: TENANT_ID,
      paymentId: asPaymentId(PAYMENT_ID),
      invoiceId: 'inv-1',
      amountSatang: 350_000n,
      status: 'pending' as const,
      processorRefundId: null,
    })),
    updateStatus: vi.fn(),
    findByProcessorRefundId: vi.fn(),
    getRefundContextForUpdate: vi.fn(async () => ({
      pendingCount: 0,
      succeededSumSatang: 0n,
      nextSeq: 1,
    })),
  };
  const tenantSettingsRepo = {
    getByTenantId: vi.fn(async () => ({
      tenantId: TENANT_ID,
      processor: 'stripe' as const,
      processorEnvironment: 'test' as const,
      processorAccountId: 'acct_test_1',
      processorPublishableKey: 'pk_test_1',
      enabledMethods: ['card', 'promptpay'] as readonly ('card' | 'promptpay')[],
      onlinePaymentEnabled: true,
      autoEmailOnPayment: true,
      promptpayQrExpirySeconds: 900,
      allowAnonymousPaylink: false,
    })),
  };
  const processorGateway = {
    createPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(),
    cancelPaymentIntent: vi.fn(),
    createRefund: vi.fn(async () =>
      ok({ id: 're_test_xxx', status: 'succeeded', amountSatang: 350_000n }),
    ),
  };
  const invoicingBridge = {
    getInvoiceForPayment: vi.fn(),
    markPaidFromProcessor: vi.fn(),
    issueCreditNoteFromRefund: vi.fn(async () =>
      ok({
        creditNoteId: 'cn_test_1',
        creditNoteNumber: 'TC-2026-000001',
      }),
    ),
  };
  const audit = { emit: vi.fn(async () => undefined) };
  const clock = { nowIso: () => new Date(NOW_MS).toISOString(), nowMs: () => NOW_MS };

  return {
    paymentsRepo: paymentsRepo as unknown as IssueRefundDeps['paymentsRepo'],
    refundsRepo: refundsRepo as unknown as IssueRefundDeps['refundsRepo'],
    tenantSettingsRepo: tenantSettingsRepo as unknown as IssueRefundDeps['tenantSettingsRepo'],
    processorGateway: processorGateway as unknown as IssueRefundDeps['processorGateway'],
    invoicingBridge: invoicingBridge as unknown as IssueRefundDeps['invoicingBridge'],
    audit,
    clock,
    generateRefundId: () => 'rfnd_01JTESTID0000000000000000',
    idempotencyKeyFactory: (k: string) => k,
    ...overrides,
  };
}

// Convenience cast — every mock above is actually a vi.fn under the hood.
function asMock<T>(fn: T): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('issueRefund (T108) — error branches', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('invalid_payment_id — paymentId fails parse regex', async () => {
    const deps = makeDeps();
    const r = await issueRefund(deps, baseInput({ paymentId: 'bad-id-too-short' }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_payment_id');
      if (r.error.code === 'invalid_payment_id') {
        expect(r.error.raw).toBe('bad-id-too-short');
      }
    }
    // Short-circuits before touching tenantSettingsRepo.
    expect(asMock(deps.tenantSettingsRepo.getByTenantId)).not.toHaveBeenCalled();
  });

  it('tenant_settings_missing — no row in tenant_payment_settings', async () => {
    const deps = makeDeps();
    asMock(deps.tenantSettingsRepo.getByTenantId).mockResolvedValueOnce(null);

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('tenant_settings_missing');
  });

  it('payment_not_found — lockForUpdate returns null', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(null);

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('payment_not_found');
    expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
  });

  it.each(['pending', 'failed', 'canceled', 'refunded'] as const)(
    'payment_not_refundable — payment.status=%s',
    async (status) => {
      const deps = makeDeps();
      asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(makePayment({ status }));

      const r = await issueRefund(deps, baseInput());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('payment_not_refundable');
        if (r.error.code === 'payment_not_refundable') {
          expect(r.error.currentStatus).toBe(status);
        }
      }
      expect(asMock(deps.processorGateway.createRefund)).not.toHaveBeenCalled();
    },
  );

  it('refund_in_progress — getRefundContextForUpdate.pendingCount > 0', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 1,
      succeededSumSatang: 0n,
      nextSeq: 1,
    });

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('refund_in_progress');
    expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
  });

  it('refund_exceeds_remaining — pre-flight FR-011b + AS6 NO audit emit', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: 5_000_000n,
      nextSeq: 1,
    });

    const r = await issueRefund(deps, baseInput({ amountSatang: 1_000_000n }));
    // payment.amount=5,350,000 - sum=5,000,000 → remaining=350,000 < 1,000,000
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('refund_exceeds_remaining');
      if (r.error.code === 'refund_exceeds_remaining') {
        expect(r.error.requestedSatang).toBe(1_000_000n);
        expect(r.error.remainingSatang).toBe(350_000n);
      }
    }
    // I6 (review 2026-04-27): AS6 explicitly states "no audit event
    // is written" on a pre-flight rejection. Without this guard, a
    // future refactor that emits `refund_initiated` BEFORE the
    // remainder check would silently violate the spec — the prior
    // `refund_in_progress.code` assertion alone does not catch it.
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
  });
});

describe('issueRefund (T108) — Stripe + F4 failure paths', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('processor_unavailable retryable — Stripe createRefund fails', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'rate_limit' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'processor_unavailable') {
      expect(r.error.kind).toBe('retryable');
      // Q1 fix: propagate gateway's `reason` (human-readable) — not the
      // discriminator. Mock supplies `reason: 'rate_limit'`.
      expect(r.error.reason).toBe('rate_limit');
    }
    // Pending refund row must have been flipped to failed + refund_failed audit emitted.
    const updateCalls = asMock(deps.refundsRepo.updateStatus).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall?.[1]).toMatchObject({ nextStatus: 'failed', failureReasonCode: 'retryable' });
    const auditCalls = asMock(deps.audit.emit).mock.calls;
    const failedAudit = auditCalls.find((c) => c[1].eventType === 'refund_failed');
    expect(failedAudit).toBeDefined();
  });

  it('processor_unavailable permanent — Stripe createRefund permanent error', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
      err({ kind: 'permanent', code: 'charge_already_refunded', reason: 'charge_already_refunded' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'processor_unavailable') {
      expect(r.error.kind).toBe('permanent');
      expect(r.error.reason).toBe('charge_already_refunded');
    }
  });

  it('processor_unavailable idempotency_conflict — preserved (Q1 fix, no longer collapsed to permanent)', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
      err({ kind: 'idempotency_conflict', reason: 'duplicate_idempotency_key' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'processor_unavailable') {
      expect(r.error.kind).toBe('idempotency_conflict');
      expect(r.error.reason).toBe('duplicate_idempotency_key');
    }
  });

  it('f4_bridge_error — F4 issueCreditNoteFromRefund fails after Stripe success', async () => {
    const deps = makeDeps();
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      err({ code: 'remainder_credit_exceeded', detail: 'CN sum > invoice total' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === 'f4_bridge_error') {
      expect(r.error.detail).toBe('CN sum > invoice total');
    }
    // Refund flipped to failed with f4_bridge_ prefix on reason code.
    const updateCalls = asMock(deps.refundsRepo.updateStatus).mock.calls;
    const failedCall = updateCalls.find((c) => c[1].nextStatus === 'failed');
    expect(failedCall?.[1].failureReasonCode).toMatch(/^f4_bridge_/);
  });
});

describe('issueRefund (T108) — happy paths', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('partial refund — payment.status → partially_refunded', async () => {
    const deps = makeDeps();
    const r = await issueRefund(deps, baseInput({ amountSatang: 350_000n }));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.refund.status).toBe('succeeded');
      expect(r.value.refund.processorRefundId).toBe('re_test_xxx');
      expect(r.value.refund.creditNoteId).toBe('cn_test_1');
      expect(r.value.refund.creditNoteNumber).toBe('TC-2026-000001');
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(350_000n);
      expect(r.value.payment.remainingRefundableSatang).toBe(5_000_000n);
      expect(r.value.invoice.status).toBe('partially_credited');
    }
    // Idempotency key uses rfnd-{paymentId}-{seq=1}
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe(`rfnd-${PAYMENT_ID}-1`);
    // refund_initiated + refund_succeeded audit emitted.
    const eventTypes = asMock(deps.audit.emit).mock.calls.map((c) => c[1].eventType);
    expect(eventTypes).toContain('refund_initiated');
    expect(eventTypes).toContain('refund_succeeded');
  });

  it('AS2 — PromptPay refund happy path uses same flow as card', async () => {
    // I7 (review 2026-04-27): AS2 explicitly states "the downstream
    // F4 credit-note flow is identical to the card case" for
    // PromptPay refunds. Pin the method-agnostic behaviour so a
    // future gateway change that treats `method='promptpay'` rows
    // differently (e.g. refusing to refund) is caught here.
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(
      makePayment({ method: 'promptpay', card: null, processorChargeId: null }),
    );

    const r = await issueRefund(deps, baseInput({ amountSatang: 350_000n }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.refund.status).toBe('succeeded');
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.invoice.status).toBe('partially_credited');
    }
    // Stripe gateway receives the PaymentIntent id of the PromptPay
    // PI — Stripe routes the refund to the originating Thai bank
    // account; no card-specific metadata in the call.
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as {
      paymentIntentId: string;
      metadata: Record<string, string>;
    };
    expect(stripeCall.paymentIntentId).toBe('pi_test_xxx');
    // F4 bridge receives the same input shape regardless of method.
    expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).toHaveBeenCalledTimes(1);
  });

  it('full refund (sum=0 + amount=total) — payment.status → refunded', async () => {
    const deps = makeDeps();
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      ok({
        creditNoteId: 'cn_full',
        creditNoteNumber: 'TC-2026-000002',
      }),
    );

    const r = await issueRefund(deps, baseInput({ amountSatang: 5_350_000n }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.payment.status).toBe('refunded');
      expect(r.value.payment.remainingRefundableSatang).toBe(0n);
      expect(r.value.invoice.status).toBe('credited');
    }
  });

  it('exhausting partial — sumBefore + amount === total → refunded', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(
      makePayment({ status: 'partially_refunded' }),
    );
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: 5_000_000n,
      nextSeq: 2,
    });
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      ok({
        creditNoteId: 'cn_exhausting',
        creditNoteNumber: 'TC-2026-000003',
      }),
    );

    const r = await issueRefund(deps, baseInput({ amountSatang: 350_000n }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.payment.status).toBe('refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(5_350_000n);
    }
  });

  it('partial refund from already-partially_refunded state', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(
      makePayment({ status: 'partially_refunded' }),
    );
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: 2_000_000n,
      nextSeq: 2,
    });

    const r = await issueRefund(deps, baseInput({ amountSatang: 1_000_000n }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(3_000_000n);
      expect(r.value.payment.remainingRefundableSatang).toBe(2_350_000n);
    }
  });

  it('idempotency key picks up nextSeq from refund context', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: 0n,
      nextSeq: 3,
    });

    await issueRefund(deps, baseInput());
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe(`rfnd-${PAYMENT_ID}-3`);
  });

  it('idempotency-key factory wraps the base key (dev salt simulation)', async () => {
    const deps = makeDeps({
      idempotencyKeyFactory: (k: string) => `${k}-dev-salt`,
    });

    await issueRefund(deps, baseInput());
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe(`rfnd-${PAYMENT_ID}-1-dev-salt`);
  });
});
