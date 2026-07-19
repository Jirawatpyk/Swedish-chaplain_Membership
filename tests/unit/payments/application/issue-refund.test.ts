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
  // Money-remediation Task 6 — emitted when a processor-settled refund's F4
  // credit note could not be booked and the row was deferred, not failed.
  refundCreditNoteDeferred: vi.fn(),
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
// Single source of truth for the fixture payment amount so the invoice-cap
// stub (getInvoiceCreditedTotal.totalSatang) is DERIVED from the payment
// amount rather than an independently-drifting literal (B.1 review Minor#2).
const PAYMENT_AMOUNT_SATANG = asSatang(5_350_000n);

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: asPaymentId(PAYMENT_ID),
    tenantId: TENANT_ID,
    invoiceId: 'inv-1',
    memberId: 'mbr-1',
    method: 'card',
    status: 'succeeded',
    amountSatang: PAYMENT_AMOUNT_SATANG,
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
/**
 * The refund row's simulated current status, shared by the `updateStatus`
 * stub so it can honour `expectedCurrentStatus` the way the adapter does.
 * Exposed on the returned deps as `__rowStatus` for tests that need to
 * simulate a sibling writer winning the race.
 */
interface RowStatusRef {
  current: string;
}

function makeDeps(
  overrides: Partial<IssueRefundDeps> = {},
  rowStatusRef: RowStatusRef = { current: 'pending' },
): IssueRefundDeps {
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
    //
    // Money-remediation Task 6 (F-10): the stub now EMULATES THE REAL
    // PREDICATE — `null` iff `expectedCurrentStatus` does not match the row's
    // current status. A stub that returns a row unconditionally would make
    // every assertion about the CAS guard vacuous: the guard could be deleted
    // and the tests would not notice. `rowStatusRef` lets a test simulate a
    // sibling that already finalised the row.
    updateStatus: vi.fn(
      async (
        _tx: unknown,
        args: { readonly expectedCurrentStatus?: string; readonly nextStatus: string },
      ) => {
        if (
          args.expectedCurrentStatus !== undefined &&
          args.expectedCurrentStatus !== rowStatusRef.current
        ) {
          return null;
        }
        rowStatusRef.current = args.nextStatus;
        return {
          id: 'rfnd_01J',
          tenantId: TENANT_ID,
          paymentId: asPaymentId(PAYMENT_ID),
          invoiceId: 'inv-1',
          amountSatang: asSatang(350_000n),
          status: args.nextStatus as 'succeeded',
          processorRefundId: 're_test_xxx',
        };
      },
    ),
    // A.6/guard#1: attach the Stripe refund id in the just-inserted
    // pending window (webhook-matchable). Returns void.
    attachProcessorRefundId: vi.fn(async () => undefined),
    findByProcessorRefundId: vi.fn(),
    getRefundContextForUpdate: vi.fn(async () => ({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
      nextSeq: 1,
      settledUnbookedCount: 0,
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
    // B.1 (#4) — refund pre-flight now reads the invoice's F4 credited/total
    // to cap at `min(payment-based, invoice-credit-based)`. Default: credited=0
    // + total===payment.amount so the invoice bound never binds tighter than
    // the payment bound → every existing assertion (payment-cap only) is
    // preserved. Per-test overrides exercise the credit-based cap.
    // F-4 (money-remediation Task 7) — the read also carries the three axes of
    // F4's credit-note gate. Defaults are the ALLOW values (a paid, creditable
    // invoice whose receipt has rendered) so every pre-existing assertion in
    // this file keeps testing what it was written to test; the F-4 describe
    // block below overrides them per axis.
    getInvoiceCreditedTotal: vi.fn(async () =>
      ok({
        creditedTotalSatang: asSatang(0n),
        totalSatang: PAYMENT_AMOUNT_SATANG,
        status: 'paid' as const,
        creditable: true,
        receiptRendered: true,
      }),
    ),
    // tax#5 (B.2) — the shared finaliser now reads the invoice's
    // F4-AUTHORITATIVE post-CN status (not a projection of the F5 payment
    // status). Default: `partially_credited` (matches the partial-refund
    // happy paths). Full-refund / manual-CN tests override per scenario.
    getInvoiceStatus: vi.fn(async () => ok('partially_credited' as const)),
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

  // ── F-3 leg 2: certainty ────────────────────────────────────────────────
  //
  // These three cases were ONE behaviour before money-remediation Task 6:
  // every gateway failure kind flipped the row to `failed`. The old test for
  // `retryable` asserted exactly that (`{nextStatus:'failed',
  // failureReasonCode:'retryable'}`) — it pinned the bug in place.
  //
  // The assertions below are deliberately NEGATIVE where it matters. Checking
  // only the returned error code would pass just as happily if someone
  // re-added the `failed` flip alongside the new behaviour, which is the
  // regression shape that actually matters: the error code is cosmetic, the
  // row state is what un-blocks a double refund.
  it.each([
    ['retryable', 'rate_limit'],
    ['idempotency_conflict', 'duplicate_idempotency_key'],
  ] as const)(
    'gateway %s leaves the row PENDING — the outcome is unknown, so `failed` would be a lie',
    async (kind, reason) => {
      const deps = makeDeps();
      asMock(deps.processorGateway.createRefund).mockResolvedValueOnce(
        err({ kind, reason }),
      );

      const r = await issueRefund(deps, baseInput());
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.code === 'processor_unavailable') {
        expect(r.error.kind).toBe(kind);
        // Q1 fix: propagate the gateway's `reason`, not the discriminator.
        expect(r.error.reason).toBe(reason);
      }

      // THE POINT: no terminal write at all. `failed` is read downstream as
      // "no money left the account" — it clears the refund_in_progress guard
      // and the settled-sum cap, so a retry can pay the customer twice.
      const failedWrites = asMock(deps.refundsRepo.updateStatus).mock.calls.filter(
        (c) => c[1].nextStatus === 'failed',
      );
      expect(failedWrites).toEqual([]);
      // …and no audit claiming the refund failed.
      const failedAudit = asMock(deps.audit.emit).mock.calls.filter(
        (c) => c[1].eventType === 'refund_failed',
      );
      expect(failedAudit).toEqual([]);
      expect(metricsMocks.refundFailedCount).not.toHaveBeenCalled();
      // The row is now the sweep's problem, and that is signalled.
      expect(metricsMocks.refundPendingAwaitingProcessor).toHaveBeenCalledWith(
        TENANT_ID,
      );
    },
  );

  it('gateway permanent DOES flip the row to failed — the processor refused, nothing moved', async () => {
    // The discrimination has to cut both ways. If all three kinds stayed
    // pending, the guard would be indiscriminate rather than correct, and
    // every genuinely-refused refund would block that payment until a sweep.
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
    const failedWrites = asMock(deps.refundsRepo.updateStatus).mock.calls.filter(
      (c) => c[1].nextStatus === 'failed',
    );
    expect(failedWrites).toHaveLength(1);
    expect(failedWrites[0]?.[1]).toMatchObject({
      nextStatus: 'failed',
      failureReasonCode: 'permanent',
      // F-10: the CAS predicate must be present, or a sibling that already
      // finalised the row gets `failed` stamped over its credit note.
      expectedCurrentStatus: 'pending',
    });
    const failedAudit = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_failed',
    );
    expect(failedAudit).toHaveLength(1);
  });

  it('f4_preflight_read_error — pre-flight F4 credited-total read fails: distinct code, money NOT moved', async () => {
    // B.1 review Fix#1 — the PRE-FLIGHT credited-total read failure (money not
    // yet moved, safe to retry, NO orphaned refund) MUST NOT reuse the
    // post-Stripe `f4_bridge_error` code (which means "Stripe DID succeed; ops
    // follow up via the out-of-band-refund runbook"). An on-call seeing
    // `f4_bridge_error` for a pre-flight failure would hunt a NON-EXISTENT
    // refund. The pre-flight path returns the distinct `f4_preflight_read_error`.
    const deps = makeDeps();
    asMock(deps.invoicingBridge.getInvoiceCreditedTotal).mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_preflight_read_error');
      // Explicitly NOT the post-Stripe code.
      expect(r.error.code).not.toBe('f4_bridge_error');
      if (r.error.code === 'f4_preflight_read_error') {
        // Detail carries the bridge sub-code for ops triage.
        expect(r.error.detail).toBe('invoice_credited_total_read_failed:not_found');
      }
    }
    // Money-safety: rejected BEFORE Stripe — createRefund never called, and no
    // pending refund row written (AS6 — pre-insert rejection).
    expect(asMock(deps.processorGateway.createRefund)).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
    // No `refund_initiated` audit either (pre-insert).
    const initiated = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'refund_initiated',
    );
    expect(initiated).toBeUndefined();
  });

  it('f4_preflight_read_error — bridge read_failed (Neon-down throw class) also maps to the pre-flight code', async () => {
    // Minor#1 — when the bridge itself catches an F4 read THROW (Neon down) it
    // returns `{ code: 'read_failed' }`; the use-case must still refuse pre-
    // Stripe with the distinct pre-flight code (graceful 502, not a raw 500).
    const deps = makeDeps();
    asMock(deps.invoicingBridge.getInvoiceCreditedTotal).mockResolvedValueOnce(
      err({ code: 'read_failed' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_preflight_read_error');
      if (r.error.code === 'f4_preflight_read_error') {
        expect(r.error.detail).toBe('invoice_credited_total_read_failed:read_failed');
      }
    }
    expect(asMock(deps.processorGateway.createRefund)).not.toHaveBeenCalled();
  });

  // ── F-4: pre-flight parity with F4's other three credit-note gates ───────
  //
  // The pre-fix pre-flight mirrored only F4's AMOUNT gate, so a refund F4
  // would decline on status / §105 creditability / receipt-render still
  // reached Stripe and moved real money.
  //
  // Each case asserts the MONEY fact first. `insert` and the `refund_initiated`
  // emit are asserted absent as well, and that pair is what pins guard
  // PLACEMENT rather than mere existence: `err()` inside `runInTenant` COMMITS,
  // so a guard below either write would leave a phantom `pending` row (which
  // then blocks every future refund on this payment) plus a false audit trail.
  const preflightRejectionCases = [
    {
      name: 'voided invoice',
      overrides: { status: 'void' as const },
      expectedCode: 'f4_preflight_invalid_status',
    },
    {
      name: 'already fully-credited invoice',
      overrides: { status: 'credited' as const },
      expectedCode: 'f4_preflight_invalid_status',
    },
    {
      name: '§105 receipt (non-VAT-registrant event buyer) — permanently uncreditable',
      overrides: { creditable: false },
      expectedCode: 'f4_preflight_not_creditable',
    },
    {
      name: 'receipt PDF not yet rendered',
      overrides: { receiptRendered: false },
      expectedCode: 'f4_preflight_receipt_not_rendered',
    },
  ];

  for (const c of preflightRejectionCases) {
    it(`F-4 — refuses BEFORE Stripe: ${c.name}`, async () => {
      const deps = makeDeps();
      asMock(deps.invoicingBridge.getInvoiceCreditedTotal).mockResolvedValueOnce(
        ok({
          creditedTotalSatang: asSatang(0n),
          totalSatang: PAYMENT_AMOUNT_SATANG,
          status: 'paid' as const,
          creditable: true,
          receiptRendered: true,
          ...c.overrides,
        }),
      );

      const r = await issueRefund(deps, baseInput());

      // Money first — before any error-code assertion, so a mutant cannot die
      // on the cosmetic check before reaching the path that matters.
      expect(asMock(deps.processorGateway.createRefund)).not.toHaveBeenCalled();
      expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
      expect(
        asMock(deps.audit.emit).mock.calls.find(
          (call) => call[1].eventType === 'refund_initiated',
        ),
      ).toBeUndefined();

      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(c.expectedCode);
    });
  }

  // The allow-list must be `paid | partially_credited`, mirroring
  // `issue-credit-note.ts:419`. F4 flips an invoice to `partially_credited`
  // once the first partial refund's credit note lands, so a `=== 'paid'`
  // shortcut would break every SECOND partial refund. This test exists solely
  // to make that shortcut fail here, at unit speed, rather than in production.
  it('F-4 — ALLOWS a refund on a partially_credited invoice (2nd partial refund)', async () => {
    const deps = makeDeps();
    asMock(deps.invoicingBridge.getInvoiceCreditedTotal).mockResolvedValueOnce(
      ok({
        creditedTotalSatang: asSatang(0n),
        totalSatang: PAYMENT_AMOUNT_SATANG,
        status: 'partially_credited' as const,
        creditable: true,
        receiptRendered: true,
      }),
    );

    const r = await issueRefund(deps, baseInput());

    expect(r.ok).toBe(true);
    expect(asMock(deps.processorGateway.createRefund)).toHaveBeenCalledTimes(1);
  });

  // ── F-3 leg 1: deferral ─────────────────────────────────────────────────
  //
  // The old form of this test asserted the F4-decline flip
  // (`failedCall?.[1].failureReasonCode).toMatch(/^f4_bridge_/)`) — i.e. it
  // pinned the money-lie. Stripe has CONFIRMED the refund succeeded here; a
  // `failed` row says the opposite, and every downstream guard believes it.
  it('F4 bridge decline after Stripe success DEFERS — row stays pending, never failed', async () => {
    const deps = makeDeps();
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      err({ code: 'remainder_credit_exceeded', detail: 'CN sum > invoice total' }),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('f4_bridge_deferred');
    if (!r.ok && r.error.code === 'f4_bridge_deferred') {
      expect(r.error.detail).toBe('CN sum > invoice total');
      // Ids carried so the caller (and F8 renewals) can match the in-flight
      // refund while the sweep reconciles it.
      expect(r.error.processorRefundId).toBe('re_test_xxx');
      expect(r.error.refundId).toBe('rfnd_01JTESTID0000000000000000');
    }

    // NEGATIVE — the whole point. Not "the code changed", but "the row was
    // never terminalised". Without this, re-adding the flip alongside the new
    // error code passes.
    const failedWrites = asMock(deps.refundsRepo.updateStatus).mock.calls.filter(
      (c) => c[1].nextStatus === 'failed',
    );
    expect(failedWrites).toEqual([]);
    const failedAudit = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_failed',
    );
    expect(failedAudit).toEqual([]);
    expect(metricsMocks.refundFailedCount).not.toHaveBeenCalled();

    // POSITIVE — the gap between "money returned" and "credit note booked" is
    // on the 10-year record for whoever reconciles output VAT.
    const deferred = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_cn_deferred',
    );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.[1].retentionYears).toBe(10);
    expect(deferred[0]?.[1].payload).toMatchObject({
      processor_refund_id: 're_test_xxx',
      defer_reason_code: 'f4_bridge_remainder_credit_exceeded',
    });
    expect(metricsMocks.refundCreditNoteDeferred).toHaveBeenCalledWith(
      TENANT_ID,
      'f4_bridge_remainder_credit_exceeded',
    );
  });

  it('Phase-B throw after Stripe success DEFERS too — same rule, other exit', async () => {
    // Both post-Stripe-success failure exits have to obey the rule, or the
    // fix only covers whichever one a reviewer happened to look at.
    const deps = makeDeps();
    let call = 0;
    asMock(deps.paymentsRepo.withTx).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        call += 1;
        // 1 = Phase A, 2 = attachProcessorRefundId, 3 = Phase B.
        if (call === 3) throw new TypeError('neon exploded mid-finalise');
        return fn(Symbol('tx'));
      },
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('f4_bridge_deferred');

    const failedWrites = asMock(deps.refundsRepo.updateStatus).mock.calls.filter(
      (c) => c[1].nextStatus === 'failed',
    );
    expect(failedWrites).toEqual([]);
    const deferred = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_cn_deferred',
    );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.[1].payload).toMatchObject({
      defer_reason_code: 'f4_bridge_phase_b_db_error',
      detail: 'TypeError',
    });
  });

  it('F-10 — a sibling that already finalised the row is not overwritten', async () => {
    // The row is `succeeded` with a credit note by the time our failure path
    // runs. Blind-writing `failed` over it violates the
    // `refunds_succeeded_iff_complete` CHECK, aborts the tx, and lands in the
    // double-fault handler — which then emits a 10-year forensic saying the
    // refund is stuck pending, about a refund that succeeded.
    const rowStatus = { current: 'pending' };
    const deps = makeDeps({}, rowStatus);
    asMock(deps.processorGateway.createRefund).mockImplementationOnce(async () => {
      // A sibling webhook wins the race while our Stripe call is in flight.
      rowStatus.current = 'succeeded';
      return err({ kind: 'permanent', code: 'charge_already_refunded', reason: 'x' });
    });

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);

    // The CAS predicate matched zero rows, so the write is a no-op and the
    // contradicting audit + metric are suppressed. The sibling owns them.
    expect(rowStatus.current).toBe('succeeded');
    const failedAudit = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_failed',
    );
    expect(failedAudit).toEqual([]);
    expect(metricsMocks.refundFailedCount).not.toHaveBeenCalled();
  });

  it('F-3 backstop — refuses outright when the payment carries a settled-unbooked row', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
      nextSeq: 2,
      settledUnbookedCount: 1,
    });

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.code).toBe('refund_needs_reconciliation');

    // Refused BEFORE the insert and BEFORE the `refund_initiated` emit —
    // `err()` inside `runInTenant` COMMITS, so a guard below either would
    // leave a phantom pending row plus a false audit trail behind a refusal.
    expect(asMock(deps.refundsRepo.insert)).not.toHaveBeenCalled();
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
    expect(asMock(deps.processorGateway.createRefund)).not.toHaveBeenCalled();
  });

  it('F-3 leg 3 — the Stripe idempotency key is derived from the refund id, not a rotating count', async () => {
    // `rfnd-{paymentId}-{COUNT(*)+1}` changed whenever ANY row existed for the
    // payment, so a retry after a first attempt sent Stripe a NEW key — which
    // Stripe correctly honoured as a new request. On a partial refund (charge
    // cap still has headroom) that is a genuine second payout.
    //
    // Asserting the LITERAL key, not just "it was called once": a call-count
    // assertion proves nothing about dedupe.
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
      // A prior attempt left rows behind — the old code would mint `…-4` here.
      nextSeq: 4,
      settledUnbookedCount: 0,
    });

    await issueRefund(deps, baseInput());

    const createArgs = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0];
    expect(createArgs?.idempotencyKey).toBe('rfnd-rfnd_01JTESTID0000000000000000');
    expect(createArgs?.idempotencyKey).not.toContain(PAYMENT_ID);
    expect(createArgs?.idempotencyKey).not.toMatch(/-4$/);
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
    // F-3 leg 3: the key is `rfnd-{refundId}` — stable for the life of this
    // logical attempt. It used to be `rfnd-{paymentId}-{COUNT(*)+1}`, which
    // rotated across retries and let Stripe treat a retry as a new request.
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe('rfnd-rfnd_01JTESTID0000000000000000');
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
    // tax#5 (B.2) — F4 flips a fully-refunded invoice to `credited`; the
    // finaliser reports THAT authoritative status.
    asMock(deps.invoicingBridge.getInvoiceStatus).mockResolvedValueOnce(
      ok('credited' as const),
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

  it('tax#5 — reports F4-AUTHORITATIVE invoice status over F5 payment arithmetic (pre-existing manual CN)', async () => {
    // The bug this fixes: a PARTIAL F5 refund leaves the payment
    // `partially_refunded`, so the old F5 payment-based projection derives
    // `partially_credited`. But when the invoice already carries a MANUAL F4
    // credit note that — together with this refund's CN — FULLY credits the
    // invoice, F4's authoritative status is `credited`. The finaliser MUST
    // report F4's status, not the F5 arithmetic.
    const deps = makeDeps();
    // F4 (the tax-document system of record) says the invoice is fully credited.
    asMock(deps.invoicingBridge.getInvoiceStatus).mockResolvedValueOnce(
      ok('credited' as const),
    );

    // A partial refund (350,000 of 5,350,000) → payment stays partially_refunded.
    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(350_000n) }));

    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      // F5 payment arithmetic (partial refund) says partially_refunded …
      expect(r.value.payment.status).toBe('partially_refunded');
      // … but the invoice status is sourced from F4 (authoritative): credited.
      // The old arithmetic projection (payment→partially_refunded ⇒
      // partially_credited) would fail this assertion.
      expect(r.value.invoice.status).toBe('credited');
    } else {
      throw new Error('expected kind=succeeded');
    }
    // The finaliser sourced the status from F4 — the read was tenant-tx-threaded.
    expect(asMock(deps.invoicingBridge.getInvoiceStatus)).toHaveBeenCalledTimes(1);
    const statusReadArgs = asMock(deps.invoicingBridge.getInvoiceStatus).mock.calls[0]?.[0] as {
      tenantId: string;
      invoiceId: string;
      externalTx: unknown;
    };
    expect(statusReadArgs.tenantId).toBe(TENANT_ID);
    expect(statusReadArgs.invoiceId).toBe('inv-1');
    // B.1 lesson — the read threads the finalize tx (no nested pooled connection).
    expect(statusReadArgs.externalTx).toBeDefined();
  });

  it('tax#5 — F4 status read error falls back to the payment projection; refund still succeeds', async () => {
    // A transient F4 read failure (Neon down / tx aborted) MUST NOT fail an
    // already-succeeded refund (the CN + Stripe refund already committed). The
    // finaliser falls back to the payment-derived projection for the display
    // hint; the DB invoice status stays F4-authoritative regardless.
    const deps = makeDeps();
    asMock(deps.invoicingBridge.issueCreditNoteFromRefund).mockResolvedValueOnce(
      ok({ creditNoteId: 'cn_fb', creditNoteNumber: 'TC-2026-000009' }),
    );
    asMock(deps.invoicingBridge.getInvoiceStatus).mockResolvedValueOnce(
      err({ code: 'read_failed' }),
    );

    // Full refund → payment refunded → fallback projection = 'credited'.
    const r = await issueRefund(deps, baseInput({ amountSatang: asSatang(5_350_000n) }));

    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'succeeded') {
      expect(r.value.refund.status).toBe('succeeded');
      expect(r.value.payment.status).toBe('refunded');
      // Fallback to the payment-derived projection when F4 read errors.
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

  it('idempotency key IGNORES nextSeq — the rotation was the F-3 double-refund vector', async () => {
    // This test used to assert the opposite (`rfnd-{paymentId}-3`). `nextSeq`
    // is `COUNT(*)+1` over ALL rows regardless of status, so any leftover row
    // from a first attempt changed the key on the retry — and Stripe honoured
    // it as a brand-new refund request.
    const deps = makeDeps();
    asMock(deps.refundsRepo.getRefundContextForUpdate).mockResolvedValueOnce({
      pendingCount: 0,
      succeededSumSatang: asSatang(0n),
      nextSeq: 3,
      settledUnbookedCount: 0,
    });

    await issueRefund(deps, baseInput());
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe('rfnd-rfnd_01JTESTID0000000000000000');
    expect(stripeCall.idempotencyKey).not.toContain('-3');
  });

  it('idempotency-key factory wraps the base key (dev salt simulation)', async () => {
    const deps = makeDeps({
      idempotencyKeyFactory: (k: string) => `${k}-dev-salt`,
    });

    await issueRefund(deps, baseInput());
    const stripeCall = asMock(deps.processorGateway.createRefund).mock.calls[0]?.[0] as { idempotencyKey: string };
    expect(stripeCall.idempotencyKey).toBe(
      'rfnd-rfnd_01JTESTID0000000000000000-dev-salt',
    );
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

  it('succeeded + Phase B DB flip throws → f4_bridge_deferred, row NOT failed', async () => {
    // Was: `f4_bridge_error` + a `failed` flip carrying
    // `failure_reason_code='f4_bridge_phase_b_db_error'`. Stripe had already
    // CONFIRMED the refund succeeded at that point, so both halves were false:
    // the row said no money moved, and the 502 read as retryable.
    const deps = makeDeps();
    // Stripe + F4 CN both succeed; the payment-status flip throws (DB outage).
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('connection terminated'),
    );

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_deferred');
    }
    const failedWrites = asMock(deps.refundsRepo.updateStatus).mock.calls.filter(
      (c) => c[1].nextStatus === 'failed',
    );
    expect(failedWrites).toEqual([]);
    const deferred = asMock(deps.audit.emit).mock.calls.filter(
      (c) => c[1].eventType === 'refund_cn_deferred',
    );
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.[1].payload).toMatchObject({
      defer_reason_code: 'f4_bridge_phase_b_db_error',
    });
  });

  it('double-fault (Phase B throws AND the deferral forensic throws) → stale_pending audit', async () => {
    // The deferral's own audit emit is now the thing that can fail. The row is
    // already in the state we want (pending + processor id) so the sweep still
    // reconciles it; what is at risk is the RECORD, hence the fallback
    // forensic. Re-read says still-pending, so it must fire.
    const deps = makeDeps();
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('phase B DB down'),
    );
    asMock(deps.audit.emit).mockImplementation(async (_tx, ev) => {
      if (ev.eventType === 'refund_cn_deferred') throw new Error('audit down');
      return undefined;
    });
    // Re-read for the F-10 terminal check: still pending → do NOT suppress.
    asMock(deps.refundsRepo.findByProcessorRefundId).mockResolvedValue({
      id: 'rfnd_01J',
      tenantId: TENANT_ID,
      paymentId: asPaymentId(PAYMENT_ID),
      invoiceId: 'inv-1',
      amountSatang: asSatang(350_000n),
      status: 'pending' as const,
      processorRefundId: 're_test_xxx',
    });

    const r = await issueRefund(deps, baseInput());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_deferred');
    }
    const staleAudit = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'stale_pending_refund_detected',
    );
    expect(staleAudit).toBeDefined();
    expect(staleAudit?.[0]).toBeNull();
    expect(staleAudit?.[1].retentionYears).toBe(10);
    expect(metricsMocks.refundFinaliseDoubleFault).toHaveBeenCalledWith(TENANT_ID);
  });

  it('double-fault forensic is SUPPRESSED when a sibling already finalised the row', async () => {
    // F-10 second half. Without the re-read, this emits a 10-year forensic
    // saying the refund is "stuck pending" about a refund that succeeded and
    // has a §86/10 credit note — an auditor-facing statement that is false.
    const deps = makeDeps();
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('phase B DB down'),
    );
    asMock(deps.audit.emit).mockImplementation(async (_tx, ev) => {
      if (ev.eventType === 'refund_cn_deferred') throw new Error('audit down');
      return undefined;
    });
    asMock(deps.refundsRepo.findByProcessorRefundId).mockResolvedValue({
      id: 'rfnd_01J',
      tenantId: TENANT_ID,
      paymentId: asPaymentId(PAYMENT_ID),
      invoiceId: 'inv-1',
      amountSatang: asSatang(350_000n),
      status: 'succeeded' as const,
      processorRefundId: 're_test_xxx',
    });

    await issueRefund(deps, baseInput());
    const staleAudit = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'stale_pending_refund_detected',
    );
    expect(staleAudit).toBeUndefined();
  });

  it('double-fault forensic STILL fires when the terminal re-read itself throws', async () => {
    // Bias check, and the one that is easy to get backwards. A false-positive
    // forensic is noise an operator dismisses; a missing one loses ten years
    // of coverage on a real money divergence. On read failure: emit.
    const deps = makeDeps();
    asMock(deps.paymentsRepo.updateStatus).mockRejectedValueOnce(
      new Error('phase B DB down'),
    );
    asMock(deps.audit.emit).mockImplementation(async (_tx, ev) => {
      if (ev.eventType === 'refund_cn_deferred') throw new Error('audit down');
      return undefined;
    });
    asMock(deps.refundsRepo.findByProcessorRefundId).mockRejectedValue(
      new Error('neon still down'),
    );

    await issueRefund(deps, baseInput());
    const staleAudit = asMock(deps.audit.emit).mock.calls.find(
      (c) => c[1].eventType === 'stale_pending_refund_detected',
    );
    expect(staleAudit).toBeDefined();
  });

  it('double-fault with null requestId + non-Error throws + logger present', async () => {
    // Covers the defensive arms: `requestId ?? 'no-request-id'`, both
    // `instanceof Error` false branches (non-Error throws), and the
    // double-fault `logger?.warn` defined branch.
    const warn = vi.fn();
    const deps = makeDeps({
      logger: { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as NonNullable<IssueRefundDeps['logger']>,
    });
    // Phase B payment flip throws a NON-Error.
    asMock(deps.paymentsRepo.updateStatus).mockImplementationOnce(async () => {
      throw 'phase-B string fault';
    });
    // The deferral forensic then throws a NON-Error too.
    asMock(deps.audit.emit).mockImplementation(async (_tx, ev) => {
      if (ev.eventType === 'refund_cn_deferred') throw 'defer string fault';
      return undefined;
    });
    asMock(deps.refundsRepo.findByProcessorRefundId).mockResolvedValue({
      id: 'rfnd_01J',
      tenantId: TENANT_ID,
      paymentId: asPaymentId(PAYMENT_ID),
      invoiceId: 'inv-1',
      amountSatang: asSatang(350_000n),
      status: 'pending' as const,
      processorRefundId: 're_test_xxx',
    });

    const r = await issueRefund(deps, baseInput({ requestId: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('f4_bridge_deferred');
      if (r.error.code === 'f4_bridge_deferred') {
        // Non-Error throw scrubbed to the constant 'unknown'.
        expect(r.error.detail).toBe('unknown');
      }
    }
    expect(warn).toHaveBeenCalledWith(
      'issue_refund.defer_emit_double_fault',
      expect.objectContaining({ deferErrKind: 'unknown' }),
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
