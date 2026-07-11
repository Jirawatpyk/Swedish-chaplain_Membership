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
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import { issueRefund } from '@/modules/payments/application/use-cases/issue-refund';
import type { IssueRefundDeps, IssueRefundInput } from '@/modules/payments/application/use-cases/issue-refund';
import type { Payment } from '@/modules/payments/domain/payment';
import { asPaymentId } from '@/modules/payments/domain/payment';

// A.9 review fix (#1) — metrics module mocked so the `refundSucceededCount`
// double-count-on-null-race regression can be asserted directly. Without
// this mock the real OTel no-op meter silently swallows every call,
// hiding a metric-gating bug behind a passing test.
const metricsMocks = vi.hoisted(() => ({
  refundInitiateCount: vi.fn(),
  refundSucceededCount: vi.fn(),
  refundFailedCount: vi.fn(),
  refundFinaliseDoubleFault: vi.fn(),
  // A.16 — emitted on the kind:'pending' return (refund awaiting the async
  // charge.refund.updated webhook). MUST be present or the real call throws.
  refundPendingAwaitingProcessor: vi.fn(),
}));
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: metricsMocks,
  };
});

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
    amountSatang: asSatang(5_350_000n),
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
    amountSatang: asSatang(350_000n),
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
      amountSatang: asSatang(350_000n),
      status: 'pending' as const,
      processorRefundId: null,
    })),
    // A.9: default returns a truthy RefundRow so the finalize helper's
    // `expectedCurrentStatus='pending'` flip is treated as "we won the
    // race" (non-null). The null/sibling-won path overrides this per-test.
    updateStatus: vi.fn(async () => ({
      id: 'rfnd_01J',
      tenantId: TENANT_ID,
      paymentId: asPaymentId(PAYMENT_ID),
      invoiceId: 'inv-1',
      amountSatang: asSatang(350_000n),
      status: 'succeeded' as const,
      processorRefundId: 're_test_xxx',
    })),
    // A.6/guard#1: attach the Stripe refund id in the just-inserted
    // pending window (webhook-matchable). Returns void.
    attachProcessorRefundId: vi.fn(async () => undefined),
    findByProcessorRefundId: vi.fn(),
    getRefundContextForUpdate: vi.fn(async () => ({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
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
      ok({ id: 're_test_xxx', status: 'succeeded', amountSatang: asSatang(350_000n) }),
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
      succeededSumSatang: asSatang(0n),
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
      succeededSumSatang: asSatang(5_000_000n),
      nextSeq: 1,
    });

    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(1_000_000n) }));
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
    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(350_000n) }));

    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.refund.status).toBe('succeeded');
      expect(r.value.refund.processorRefundId).toBe('re_test_xxx');
      expect(r.value.refund.creditNoteId).toBe('cn_test_1');
      expect(r.value.refund.creditNoteNumber).toBe('TC-2026-000001');
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(350_000n);
      expect(r.value.payment.remainingRefundableSatang).toBe(5_000_000n);
      expect(r.value.invoice.status).toBe('partially_credited');
    } else {
      throw new Error('expected kind=succeeded');
    }
    // A.9: card refund with Stripe status=succeeded books immediately +
    // attaches the processor_refund_id in the pending window.
    expect(asMock(deps.refundsRepo.attachProcessorRefundId)).toHaveBeenCalledTimes(1);
    expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).toHaveBeenCalledTimes(1);
    // Idempotency key uses rfnd-{paymentId}-{seq=1}
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe(`rfnd-${PAYMENT_ID}-1`);
    // refund_initiated + refund_succeeded audit emitted.
    const auditCalls = asMock(deps.audit.emit).mock.calls;
    const eventTypes = auditCalls.map((c) => c[1].eventType);
    expect(eventTypes).toContain('refund_initiated');
    expect(eventTypes).toContain('refund_succeeded');
    // Staff-review R2 R005 (2026-04-28): both refund events are
    // tax-document-adjacent (each triggers F4 credit-note issuance) →
    // 10y retention per F5_AUDIT_RETENTION_YEARS.
    const initiated = auditCalls.find((c) => c[1].eventType === 'refund_initiated');
    const succeeded = auditCalls.find((c) => c[1].eventType === 'refund_succeeded');
    expect(initiated?.[1].retentionYears).toBe(10);
    expect(succeeded?.[1].retentionYears).toBe(10);
    // A.9 review fix (#1) — the genuine-finalize path (this writer actually
    // flipped the refund row, `updateStatus` returned non-null) owns the
    // metric increment: exactly once.
    expect(metricsMocks.refundSucceededCount).toHaveBeenCalledTimes(1);
    expect(metricsMocks.refundSucceededCount).toHaveBeenCalledWith(TENANT_ID);
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

    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(350_000n) }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.refund.status).toBe('succeeded');
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.invoice.status).toBe('partially_credited');
    } else {
      throw new Error('expected kind=succeeded');
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

    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(5_350_000n) }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.payment.status).toBe('refunded');
      expect(r.value.payment.remainingRefundableSatang).toBe(0n);
      expect(r.value.invoice.status).toBe('credited');
    } else {
      throw new Error('expected kind=succeeded');
    }
  });

  it('exhausting partial — sumBefore + amount === total → refunded', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(
      makePayment({ status: 'partially_refunded' }),
    );
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(5_000_000n),
      nextSeq: 2,
    });
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      ok({
        creditNoteId: 'cn_exhausting',
        creditNoteNumber: 'TC-2026-000003',
      }),
    );

    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(350_000n) }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.payment.status).toBe('refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(5_350_000n);
    } else {
      throw new Error('expected kind=succeeded');
    }
  });

  it('partial refund from already-partially_refunded state', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.lockForUpdate).mockResolvedValueOnce(
      makePayment({ status: 'partially_refunded' }),
    );
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(2_000_000n),
      nextSeq: 2,
    });

    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(1_000_000n) }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.payment.status).toBe('partially_refunded');
      expect(r.value.payment.refundedAmountSatang).toBe(3_000_000n);
      expect(r.value.payment.remainingRefundableSatang).toBe(2_350_000n);
    } else {
      throw new Error('expected kind=succeeded');
    }
  });

  it('idempotency key picks up nextSeq from refund context', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
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

// ---------------------------------------------------------------------------
// Bug #1 — issueRefund finalizes a credit note ONLY when Stripe reports the
// refund as `succeeded`. `pending`/`requires_action` await the webhook;
// `failed`/`canceled` mark the refund failed with the processor id attached.
// 100% branch coverage over the `switch (stripeRefund.value.status)`.
// ---------------------------------------------------------------------------
describe('issueRefund (#1) — Stripe refund-status branch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('attaches processor_refund_id in the pending window BEFORE branching (all ok statuses)', async () => {
    const deps = makeDeps();
    await issueRefund(deps, baseInput());
    // The attach runs after createRefund ok, before any status flip, so the
    // row is webhook-matchable even for the pending/requires_action path.
    const attachCall = asMock(deps.refundsRepo.attachProcessorRefundId).mock.calls[0]?.[1] as {
      refundId: string;
      tenantId: string;
      processorRefundId: string;
    };
    expect(attachCall.processorRefundId).toBe('re_test_xxx');
    expect(attachCall.tenantId).toBe(TENANT_ID);
  });

  it.each(['pending', 'requires_action'] as const)(
    'status=%s → kind:pending, NO credit note, NO payment flip, refund stays pending',
    async (status) => {
      const deps = makeDeps();
      asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
        ok({ id: 're_async_1', status, amountSatang: asSatang(350_000n) }),
      );

      const r = await issueRefund(deps, baseInput());
      expect(r.ok).toBe(true);
      if (r.ok && r.value.kind === 'pending') {
        expect(r.value.refund.status).toBe('pending');
        expect(r.value.refund.processorRefundId).toBe('re_async_1');
        expect(r.value.refund.id).toBe('rfnd_01JTESTID0000000000000000');
      } else {
        throw new Error('expected kind=pending');
      }
      // No credit note issued; no payment flip.
      expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).not.toHaveBeenCalled();
      expect(asMock(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
      // The refund row is NOT flipped to failed either (stays pending).
      const flippedToFailed = asMock(deps.refundsRepo.updateStatus).mock.calls.find(
        (c) => c[1].nextStatus === 'failed',
      );
      expect(flippedToFailed).toBeUndefined();
      // processor_refund_id still attached in the pending window (matchable).
      expect(asMock(deps.refundsRepo.attachProcessorRefundId)).toHaveBeenCalledTimes(1);
      // refund_succeeded audit must NOT be emitted on the pending path.
      const succeededAudit = asMock(deps.audit.emit).mock.calls.find(
        (c) => c[1].eventType === 'refund_succeeded',
      );
      expect(succeededAudit).toBeUndefined();
      // A.16 (H-e) — the awaiting-processor monitoring signal fires so a
      // disabled charge.refund.updated subscription (refunds hang) is alertable.
      expect(metricsMocks.refundPendingAwaitingProcessor).toHaveBeenCalledWith(TENANT_ID);
    },
  );

  it.each(['failed', 'canceled'] as const)(
    'status=%s → processor_unavailable(permanent) + finaliseFailedRefund persists processor_refund_id + NO CN',
    async (status) => {
      const deps = makeDeps();
      asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
        ok({ id: 're_dead_1', status, amountSatang: asSatang(350_000n) }),
      );

      const r = await issueRefund(deps, baseInput());
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.code === 'processor_unavailable') {
        expect(r.error.kind).toBe('permanent');
        // The Stripe refund status is surfaced as the closed-union reason.
        expect(r.error.reason).toBe(status);
      } else {
        throw new Error('expected processor_unavailable');
      }
      // No F4 credit note on a failed/canceled Stripe refund.
      expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).not.toHaveBeenCalled();
      // The pending row is flipped to failed AND the processor id persisted
      // (forensic completeness + webhook-matchable).
      const failedCall = asMock(deps.refundsRepo.updateStatus).mock.calls.find(
        (c) => c[1].nextStatus === 'failed',
      );
      expect(failedCall?.[1].processorRefundId).toBe('re_dead_1');
      const failedAudit = asMock(deps.audit.emit).mock.calls.find(
        (c) => c[1].eventType === 'refund_failed',
      );
      expect(failedAudit).toBeDefined();
    },
  );

  it('unexpected Stripe status → treated as pending-awaiting (safe: never books success) + warns', async () => {
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as NonNullable<IssueRefundDeps['logger']>,
    });
    asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
      // Not one of the known statuses — must NOT book success nor mark failed.
      ok({ id: 're_weird_1', status: 'requires_capture', amountSatang: asSatang(350_000n) }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'pending') {
      expect(r.value.refund.processorRefundId).toBe('re_weird_1');
    } else {
      throw new Error('expected kind=pending for an unexpected status');
    }
    expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).not.toHaveBeenCalled();
    expect(asMock(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
    // The drift-detection warn fired with a bounded status string only.
    expect(warn).toHaveBeenCalledWith(
      'issue_refund.unexpected_stripe_refund_status',
      expect.objectContaining({ stripeRefundStatus: 'requires_capture' }),
    );
  });

  it('succeeded + sibling-won race (updateStatus→null) → kind:succeeded, NO double payment flip / audit', async () => {
    const deps = makeDeps();
    // A concurrent charge.refund.updated webhook finalized the same refund
    // first: the guarded flip matches zero rows → repo returns null (A.5).
    asMock(deps.refundsRepo.updateStatus).mockResolvedValueOnce(null);

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      // The idempotent F4 CN read (A.7) still returns the existing CN.
      expect(r.value.refund.creditNoteId).toBe('cn_test_1');
      expect(r.value.refund.status).toBe('succeeded');
    } else {
      throw new Error('expected kind=succeeded on the sibling-won path');
    }
    // The CN issuance ran (idempotent — returned the sibling's CN).
    expect(asMock(deps.invoicingBridge.issueCreditNoteFromRefund)).toHaveBeenCalledTimes(1);
    // Sibling already flipped the payment → we must NOT flip it again.
    expect(asMock(deps.paymentsRepo.updateStatus)).not.toHaveBeenCalled();
    // Sibling already emitted refund_succeeded → we must NOT emit a duplicate.
    const succeededAudit = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_succeeded',
    );
    expect(succeededAudit.length).toBe(0);
    // A.9 review fix (#1) — the sibling that actually flipped the row
    // (the concurrent webhook writer, once A.11 lands) owns the metric
    // increment. This loser MUST NOT double-count refundSucceededCount.
    expect(metricsMocks.refundSucceededCount).not.toHaveBeenCalled();
  });

  it('succeeded + Phase B DB flip throws → f4_bridge_error (out-of-band recovery)', async () => {
    const deps = makeDeps();
    // Stripe + F4 CN both succeed; the payment-status flip throws (DB outage).
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('connection terminated'),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_error');
    }
    // The pending row is flipped to failed with the phase-B discriminator.
    const failedCall = asMock(deps.refundsRepo.updateStatus).mock.calls.find(
      (c) => c[1].nextStatus === 'failed',
    );
    expect(failedCall?.[1].failureReasonCode).toBe('f4_bridge_phase_b_db_error');
  });

  it('succeeded + double-fault (Phase B flip AND finaliseFailedRefund both throw) → stale_pending audit', async () => {
    const deps = makeDeps();
    // Helper's refund flip succeeds (call #1), payment flip throws → caught
    // → finaliseFailedRefund runs, whose own refund flip (call #2) also
    // throws → the double-fault `.catch` emits the synchronous
    // `stale_pending_refund_detected` forensic audit (10y) on a null tx.
    asMock(deps.refundsRepo.updateStatus)
      .mockImplementationOnce(async () => ({
        id: 'rfnd_01J',
        tenantId: TENANT_ID,
        paymentId: asPaymentId(PAYMENT_ID),
        invoiceId: 'inv-1',
        amountSatang: asSatang(350_000n),
        status: 'succeeded' as const,
        processorRefundId: 're_test_xxx',
      }))
      .mockImplementationOnce(async () => {
        throw new Error('failed-flip DB down');
      });
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('phase B DB down'),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_error');
    }
    // The synchronous double-fault forensic audit fired on a null tx.
    const staleAudit = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'stale_pending_refund_detected',
    );
    expect(staleAudit).toBeDefined();
    expect(staleAudit?.[0]).toBeNull();
    expect(staleAudit?.[1].retentionYears).toBe(10);
  });

  it('double-fault with null requestId + non-Error throws + logger present', async () => {
    // Covers the defensive arms: `requestId ?? 'no-request-id'`, both
    // `instanceof Error` false branches (non-Error throws), and the
    // double-fault `logger?.warn` defined branch.
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as NonNullable<IssueRefundDeps['logger']>,
    });
    asMock(deps.refundsRepo.updateStatus)
      .mockImplementationOnce(async () => ({
        id: 'rfnd_01J',
        tenantId: TENANT_ID,
        paymentId: asPaymentId(PAYMENT_ID),
        invoiceId: 'inv-1',
        amountSatang: asSatang(350_000n),
        status: 'succeeded' as const,
        processorRefundId: 're_test_xxx',
      }))
      // finaliseFailedRefund's failed flip throws a NON-Error.
      .mockImplementationOnce(async () => {
        throw 'failed-flip string fault';
      });
    // Phase B payment flip throws a NON-Error.
    asMock(deps.paymentsRepo.updateStatus).mockImplementationOnce(async () => {
      throw 'phase-B string fault';
    });

    const r = await issueRefund(deps, baseInput({ requestId: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_error');
      if (r.error.code === 'f4_bridge_error') {
        // Non-Error throw scrubbed to the constant 'unknown'.
        expect(r.error.detail).toBe('unknown');
      }
    }
    expect(warn).toHaveBeenCalledWith(
      'issue_refund.finalise_failed_double_fault',
      expect.objectContaining({ finaliseErrKind: 'unknown' }),
    );
    const staleAudit = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'stale_pending_refund_detected',
    );
    // Null requestId falls back to the sentinel in the audit payload.
    expect(
      (staleAudit?.[1].payload as { original_correlation_id: string }).original_correlation_id,
    ).toBe('no-request-id');
  });

  it('span wrapper re-throws an uncaught body error (createRefund throws)', async () => {
    const deps = makeDeps();
    // A raw SDK throw (not an err Result) is NOT swallowed by the body — it
    // propagates through the OTel span wrapper, which sets ERROR status +
    // re-throws so the route's outer try/catch maps it to a 500.
    asMock(deps.processorGateway.createRefund).mockRejectedValueOnce(
      new Error('stripe sdk exploded'),
    );
    await expect(issueRefund(deps, baseInput())).rejects.toThrow('stripe sdk exploded');
  });

  it('span wrapper handles a non-Error throw (refund_threw branch)', async () => {
    const deps = makeDeps();
    // Non-Error throw exercises the `e instanceof Error ? … : 'refund_threw'`
    // false branch in the span status message.
    asMock(deps.processorGateway.createRefund).mockImplementationOnce(async () => {
      throw 'string-shaped failure';
    });
    await expect(issueRefund(deps, baseInput())).rejects.toBe('string-shaped failure');
  });
});
