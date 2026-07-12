/**
 * T057 unit tests — confirmPayment use-case.
 * Target: 100% branch coverage (Constitution Principle II).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import { confirmPayment, type ConfirmPaymentDeps } from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';

const TENANT_ID = 'tnt_abc';
const PAYMENT_INTENT_ID = 'pi_test_abc';

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
  id: asPaymentId('pmt_01JABCDE_TEST'),
  tenantId: TENANT_ID,
  invoiceId: 'inv_01JABCDE_XYZ',
  memberId: 'mem_01J_MEM',
  method: 'card',
  status: 'pending',
  amountSatang: asSatang(5_350_000n),
  currency: 'THB',
  processorPaymentIntentId: PAYMENT_INTENT_ID,
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

function makeDeps(): ConfirmPaymentDeps {
  const paymentsRepo = {
    withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({})),
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(async () => PENDING_PAYMENT),
    insert: vi.fn(),
    updateStatus: vi.fn(async () => ({ ...PENDING_PAYMENT, status: 'succeeded' as const })),
    // A.13 (#3 / CRITICAL-2) — stale auto-refund terminalises the row.
    // Default: guard hits (row was pending) → returns the flipped payment
    // carrying the durable marker + completed_at.
    markAutoRefunded: vi.fn(async () => ({
      ...PENDING_PAYMENT,
      status: 'auto_refunded' as const,
      completedAt: new Date('2026-05-12T07:00:00.000Z'),
      autoRefundProcessorRefundId: 're_test_auto',
    })),
    // A.15 (#8) — status-preserving marker write on a terminal `failed`
    // row. Default: guard hits (row was failed + marker NULL) → returns the
    // still-`failed` row carrying the durable marker (status NOT flipped).
    attachAutoRefundMarkerOnFailed: vi.fn(async () => ({
      ...PENDING_PAYMENT,
      status: 'failed' as const,
      completedAt: new Date('2026-05-12T06:30:00.000Z'),
      failureReasonCode: 'card_declined',
      autoRefundProcessorRefundId: 're_test_auto',
    })),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(async () => []),
    nextAttemptSeq: vi.fn(),
  };
  const tenantSettingsRepo = {
    getByTenantId: vi.fn(async () => SETTINGS_OK),
    findByProcessorAccountId: vi.fn(),
  };
  const processorGateway = {
    createPaymentIntent: vi.fn(),
    retrievePaymentIntent: vi.fn(async () =>
      ok({
        id: PAYMENT_INTENT_ID,
        status: 'succeeded',
        latestChargeId: 'ch_test_123',
        livemode: false,
        lastPaymentErrorCode: null,
        card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
      }),
    ),
    cancelPaymentIntent: vi.fn(),
    createRefund: vi.fn(async () =>
      ok({ id: 're_test_auto', status: 'succeeded', amountSatang: asSatang(5_350_000n) }),
    ),
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
  };
  const audit = { emit: vi.fn(async () => undefined) };
  const clock = {
    nowIso: () => '2026-05-12T07:00:00.000Z',
    nowMs: () => 1_747_033_200_000,
  };
  return {
    paymentsRepo: paymentsRepo as unknown as ConfirmPaymentDeps['paymentsRepo'],
    tenantSettingsRepo: tenantSettingsRepo as unknown as ConfirmPaymentDeps['tenantSettingsRepo'],
    processorGateway: processorGateway as unknown as ConfirmPaymentDeps['processorGateway'],
    invoicingBridge: invoicingBridge as unknown as ConfirmPaymentDeps['invoicingBridge'],
    audit: audit as unknown as ConfirmPaymentDeps['audit'],
    clock,
    // Inert in this unit test: the bridge is mocked, so the flow flag only
    // reaches the (stubbed) payability read. The webhook read sets
    // reconciliationPath:true, so the guard would be dormant regardless.
    taxAtPayment: 'off' as const,
  };
}

// A.15 (#8 resume-race) — the row committed `failed` (post
// `payment_intent.payment_failed`) then received a late
// `payment_intent.succeeded`. Terminal `failed` carries a `completed_at`
// (migration 0033 CHECK) + a failure reason.
const FAILED_PAYMENT: Payment = {
  ...PENDING_PAYMENT,
  status: 'failed',
  failureReasonCode: 'card_declined',
  completedAt: new Date('2026-05-12T06:30:00Z'),
};

const INPUT = {
  tenantId: TENANT_ID,
  paymentIntentId: PAYMENT_INTENT_ID,
  correlationId: 'corr_1',
  requestId: 'req_1',
  eventCreatedAtUnixSeconds: 1_747_033_200,
};

describe('confirmPayment (T057)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path — succeeded state, F4 markPaid called, payment_succeeded audit', async () => {
    const deps = makeDeps();
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    // Round-3 lock — the reconciliation READ MUST carry `reconciliationPath: true`
    // so F4's stranded-funds guard stays DORMANT on the webhook path. A boolean
    // flip here (true→false) would wrongly reject/auto-refund a Stripe-captured
    // payment; the mocked bridge ignores the arg, so this pins the literal the
    // use-case sets (get-invoice call-site wiring, Round-3 test-lens gap).
    expect(deps.invoicingBridge.getInvoiceForPayment).toHaveBeenCalledWith(
      expect.objectContaining({ reconciliationPath: true }),
    );
    expect(deps.invoicingBridge.markPaidFromProcessor).toHaveBeenCalledTimes(1);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const succeededCall = auditCalls.find((c) => c[1].eventType === 'payment_succeeded');
    expect(succeededCall).toBeDefined();
    // Staff-review R2 R005 (2026-04-28): pin retention so a regression on
    // `F5_AUDIT_RETENTION_YEARS['payment_succeeded']` (10y — tax-document
    // adjacent per Thai RD §87/3) does not pass green silently at unit layer.
    expect(succeededCall?.[1].retentionYears).toBe(10);
  });

  // R2 CRIT-1 (2026-04-27): pins audit-chain ordering across F5+F4 for
  // US1 AS1. The full chain `payment_initiated → payment_succeeded →
  // invoice_paid` spans 2 use-cases (initiate-payment.test.ts asserts
  // `payment_initiated`; F4 markPaidFromProcessor emits `invoice_paid`).
  // At this seam we pin: `payment_succeeded` MUST be emitted BEFORE
  // F4 `markPaidFromProcessor` is called, so the chain reads in
  // chronological order from the audit_log query in production.
  // (E2E `payment-card-happy-path.spec.ts` admin-timeline assertion is
  // skipped pending F5.1 audit-log UI; this contract pin replaces it.)
  it('CRIT-1 chain order — payment_succeeded audit emit precedes F4 markPaidFromProcessor', async () => {
    const deps = makeDeps();
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    const succeededEmitOrder =
      (deps.audit.emit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const markPaidOrder = (
      deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    expect(succeededEmitOrder).toBeDefined();
    expect(markPaidOrder).toBeDefined();
    expect(succeededEmitOrder!).toBeLessThan(markPaidOrder!);
  });

  it('tenant settings missing — bridge_error tenant_settings_missing', async () => {
    const deps = makeDeps();
    (deps.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bridge_error');
  });

  it('unknown intent — unknown_intent outcome', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('unknown_intent');
  });

  it('invoice not found — invoice_not_found outcome (atomic markProcessed)', async () => {
    // invoice_not_found now folds markProcessed into the
    // same withTx and returns ok({ kind: 'invoice_not_found' }) so the
    // processor_events row does not get stuck across Stripe retries.
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('invoice_not_found');
  });

  it('stale invoice (paid) — auto_refunded + concurrent_manual_mark audit (R3 CRIT-A)', async () => {
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
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(deps.processorGateway.createRefund).toHaveBeenCalled();
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    // R3 CRIT-A (2026-04-28): cause=`invoice_already_paid` →
    // `payment_auto_refunded_concurrent_manual_mark` per spec edge case.
    expect(
      auditCalls.some(
        (c) => c[1].eventType === 'payment_auto_refunded_concurrent_manual_mark',
      ),
    ).toBe(true);
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  // A.13 (#3 / CRITICAL-2) — the stale auto-refund must TERMINALISE the
  // payment (pending → auto_refunded) + durably record the Stripe refund
  // id so the later `charge.refund.updated` webhook recognises the
  // auto-refund instead of firing a false out-of-band alert. Pre-fix the
  // payment stayed `pending` forever (stuck row) and the durable marker
  // was never written.
  it('A.13 — stale auto-refund flips pending → auto_refunded + durable marker (NOT succeeded, no CN)', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'void' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // The row is terminalised via the DEDICATED markAutoRefunded write —
    // carrying the `re_…` id from the Stripe refund + a completed_at
    // (migration 0033 CHECK `payments_completed_at_iff_not_pending`).
    expect(deps.paymentsRepo.markAutoRefunded).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.markAutoRefunded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: PENDING_PAYMENT.id,
        tenantId: TENANT_ID,
        processorRefundId: 're_test_auto',
        completedAt: expect.any(Date),
      }),
    );

    // NOT the succeeded flip (auto_refunded is excluded from the
    // succeeded lineage) and NO F4 credit note (tax#4 — a stale-invoice
    // auto-refund is a payment-level reversal, not a refund-with-CN).
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // The audit carries the SAME `re_…` id as the durable marker, so a
    // later webhook can correlate the two.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const autoRefundAudit = auditCalls.find(
      (c) => c[1].eventType === 'payment_auto_refunded_stale_invoice',
    );
    expect(autoRefundAudit?.[1].payload.processor_refund_id).toBe('re_test_auto');
  });

  // A.13 — guard-miss branch: a concurrent writer terminalised the row
  // between Phase A (saw pending) and the Phase B flip. markAutoRefunded
  // returns null; the use-case STILL emits the money-trail audit +
  // markProcessed (Stripe DID refund) and returns the stale outcome.
  it('A.13 — markAutoRefunded guard miss (concurrent terminalisation) still audits + acks', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'void' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    (deps.paymentsRepo.markAutoRefunded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    // Forensic money-trail audit still fires (Stripe accepted the refund).
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) => c[1].eventType === 'payment_auto_refunded_stale_invoice'),
    ).toBe(true);
  });

  // Guard-miss sub-case (ii): the locked row was ALREADY terminal `failed`
  // (a late captured charge on a NON-payable invoice routes through Step 3,
  // which runs before the transition check and never inspects payment.status).
  // markAutoRefunded's `status='pending'` guard cannot match → fall back to
  // the A.15 status-preserving marker so A.11 recognises the refund instead of
  // firing a false OOB. Distinct from sub-case (i) above (pending row raced to
  // a different terminal status → runbook warn, no marker).
  it('guard-miss (ii) — failed row in stale Step-3 stamps the A.15 marker (auto_refund_recognized, not false OOB)', async () => {
    const deps = makeDeps();
    // Locked row is terminal `failed`.
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    // Invoice is NON-payable → Step-3 stale path.
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'void' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    // markAutoRefunded guards status='pending' → null on a `failed` row.
    (deps.paymentsRepo.markAutoRefunded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // Step-3 stale path (auto-refund- namespace), guard-missed markAutoRefunded.
    expect(deps.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `auto-refund-${FAILED_PAYMENT.id}` }),
    );
    expect(deps.paymentsRepo.markAutoRefunded).toHaveBeenCalledTimes(1);

    // THE FIX: the A.15 status-preserving marker is stamped so A.11 recognises
    // the refund; the row is NOT flipped to auto_refunded (F-9).
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: FAILED_PAYMENT.id,
        tenantId: TENANT_ID,
        processorRefundId: 're_test_auto',
      }),
    );

    // The money-trail audit still fires.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) => c[1].eventType === 'payment_auto_refunded_stale_invoice'),
    ).toBe(true);
  });

  it('stale invoice (void) — cause=invoice_voided', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'void' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
  });

  it('stale invoice (credited) — cause=invoice_credited', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'credited' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
  });

  it('stale invoice via not_payable error — still auto-refunds', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'not_payable', status: 'void' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
  });

  it('auto-refund createRefund failure — processor_unavailable error', async () => {
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
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
  });

  /**
   * F5R1-MED-TESTS — pin the F5R1-E9 closure: the give-up branch when
   * (a) the invoice is stale (auto-refund attempted), (b) Stripe's
   * createRefund still fails, AND (c) the event itself is already
   * older than 48h. Without this branch the dispatcher would keep
   * returning 500 → Stripe keeps retrying for the full 72h window
   * → audit-log + SRE alerts get polluted.
   *
   * The branch must:
   *   1. Return ok({ kind: 'auto_refund_given_up', ... }) NOT err.
   *   2. Emit `out_of_band_refund_detected` with the grep-able
   *      summary "Auto-refund giving up after Xh" — the SRE alert
   *      rule uses a `summary LIKE 'Auto-refund giving up%'` filter.
   *   3. Carry runbook URL in the audit payload so the on-call
   *      engineer can reach the recovery doc.
   */
  it('R1-E9: stale-refund give-up after 48h → auto_refund_given_up + out_of_band audit', async () => {
    const deps = makeDeps();
    // Stale invoice (paid by manual reconciliation while Stripe was
    // retrying) → triggers auto-refund branch.
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'paid' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    // Refund call also fails → enters E9's give-up vs retry branch.
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    // Override clock to be 49 hours after the event timestamp so the
    // eventAge check (>48h) trips into the give-up branch.
    const eventTs = INPUT.eventCreatedAtUnixSeconds;
    deps.clock.nowMs = () => (eventTs + 49 * 60 * 60) * 1000;

    const result = await confirmPayment(deps, INPUT);

    // 1. NOT err — give-up returns a typed ok outcome to break the
    //    Stripe retry loop.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_given_up');

    // 2. out_of_band_refund_detected audit emitted with the grep-able
    //    summary the SRE alert rule pivots on.
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const giveUpCall = auditCalls.find(
      (c) =>
        c[1]?.eventType === 'out_of_band_refund_detected' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.startsWith('Auto-refund giving up after '),
    );
    expect(giveUpCall, 'expected out_of_band_refund_detected give-up audit').toBeDefined();
    if (!giveUpCall) return;

    // 3. Summary includes the actual hours (Xh format) so the on-call
    //    sees how long the retry was running before give-up.
    expect(giveUpCall[1].summary).toMatch(/Auto-refund giving up after \d+h/);
    // 4. Runbook URL in payload so on-call can jump to the recovery doc.
    expect(giveUpCall[1].payload).toMatchObject({
      runbook_url: 'docs/runbooks/out-of-band-refund.md',
    });
  });

  it('terminal state (already succeeded) — already_succeeded no-op (reliability F-01)', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, status: 'refunded' as const },
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_succeeded');
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  // ===================================================================
  // A.15 (#8 resume-race) — failed → succeeded late-charge reconcile.
  // ===================================================================

  it('A.15 (#8) — failed→succeeded late charge auto-refunds + forensic audit + durable marker, row stays failed (F-9)', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reuses the `auto_refunded_stale_invoice` outcome kind (dispatcher
    // already handles it; sub-decision 1).
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // 1) The captured funds ARE auto-refunded (distinct idempotency
    //    namespace + the new cause on the metadata).
    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(deps.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `late-charge-refund-${FAILED_PAYMENT.id}`,
        metadata: expect.objectContaining({
          cause: 'payment_terminal_failed_late_charge',
        }),
      }),
    );

    // 2) The durable marker is stamped via the STATUS-PRESERVING write —
    //    NOT markAutoRefunded (which would flip to auto_refunded; F-9
    //    forbids that edge) and NOT updateStatus (no succeeded flip).
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: FAILED_PAYMENT.id,
        tenantId: TENANT_ID,
        processorRefundId: 're_test_auto',
      }),
    );
    expect(deps.paymentsRepo.markAutoRefunded).not.toHaveBeenCalled();
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();

    // 3) The invoice is NOT flipped paid (it stays payable).
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();

    // 4) The forensic 10y money-trail carries the new cause + the SAME
    //    `re_…` id as the marker (so a later charge.refund.updated can
    //    correlate the two via findAutoRefundByProcessorRefundId).
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const forensic = auditCalls.find(
      (c) => c[1].eventType === 'payment_auto_refunded_stale_invoice',
    );
    expect(forensic).toBeDefined();
    expect(forensic?.[1].payload.cause).toBe('payment_terminal_failed_late_charge');
    expect(forensic?.[1].payload.processor_refund_id).toBe('re_test_auto');
    expect(forensic?.[1].retentionYears).toBe(10);
  });

  it('A.15 (#8) — succeeded event with NO captured charge is NOT refunded (defensive markProcessed + warn)', async () => {
    const warn = vi.fn();
    const deps = { ...makeDeps(), logger: { warn } };
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: PAYMENT_INTENT_ID,
        status: 'succeeded',
        latestChargeId: null,
        livemode: false,
        lastPaymentErrorCode: null,
        card: null,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_succeeded');
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'confirm_payment.late_charge_no_captured_charge',
      expect.objectContaining({ paymentId: FAILED_PAYMENT.id }),
    );
  });

  it('A.15 (#8) — late-charge createRefund failure (<48h) → processor_unavailable (Stripe retries)', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    expect(deps.paymentsRepo.attachAutoRefundMarkerOnFailed).not.toHaveBeenCalled();
  });

  it('A.15 (#8) — late-charge give-up after 48h → auto_refund_given_up + out_of_band audit', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const eventTs = INPUT.eventCreatedAtUnixSeconds;
    deps.clock.nowMs = () => (eventTs + 49 * 60 * 60) * 1000;

    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refund_given_up');
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const giveUp = auditCalls.find(
      (c) =>
        c[1]?.eventType === 'out_of_band_refund_detected' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.startsWith('Auto-refund giving up after '),
    );
    expect(giveUp).toBeDefined();
    // PCI-clean: forensic uses the pi_ charge id, never card metadata.
    expect(giveUp?.[1].payload).toMatchObject({
      runbook_url: 'docs/runbooks/out-of-band-refund.md',
    });
  });

  it('A.15 (#8) — late-charge retrievePaymentIntent failure → processor_unavailable (no refund attempted)', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
  });

  // Regression: EVERY OTHER prior state that reaches the terminal_state /
  // illegal_transition branches is UNTOUCHED by the A.15 failed-gate —
  // succeeded→succeeded and canceled/refunded/auto_refunded→succeeded MUST
  // NOT trigger a late-charge auto-refund. (Coordinator-required.)
  it('A.15 (#8) — succeeded→succeeded and canceled/refunded/auto_refunded→succeeded are UNTOUCHED (no refund, no marker)', async () => {
    for (const status of ['succeeded', 'canceled', 'refunded', 'auto_refunded'] as const) {
      const deps = makeDeps();
      (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        { ...PENDING_PAYMENT, status, completedAt: new Date('2026-05-12T06:30:00Z') },
      );
      const result = await confirmPayment(deps, INPUT);
      expect(result.ok, `status=${status}`).toBe(true);
      if (!result.ok) return;
      // succeeded→succeeded is `illegal_transition` (succeeded is NOT
      // terminal in the table); canceled/refunded/auto_refunded are
      // `terminal_state`. Both land on `already_succeeded` no-op.
      expect(result.value.kind, `status=${status}`).toBe('already_succeeded');
      expect(
        deps.processorGateway.createRefund,
        `status=${status} must not refund`,
      ).not.toHaveBeenCalled();
      expect(
        deps.paymentsRepo.attachAutoRefundMarkerOnFailed,
        `status=${status} must not stamp marker`,
      ).not.toHaveBeenCalled();
      expect(
        deps.invoicingBridge.markPaidFromProcessor,
        `status=${status} must not pay invoice`,
      ).not.toHaveBeenCalled();
    }
  });

  it('illegal transition (partially_refunded → succeeded) — R4 I-3: ack + no-op (NOT err) to break Stripe retry loop', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      // partially_refunded has destinations but NOT `succeeded` — fits
      // the `illegal_transition` (non-terminal) branch.
      { ...PENDING_PAYMENT, status: 'partially_refunded' as const },
    );
    const result = await confirmPayment(deps, INPUT);
    // R4 I-3 behaviour change: was `err({code:'illegal_transition'})`
    // which 500-ed Stripe and caused 24h retry loop on a permanent
    // mismatch. Now acknowledged as `already_succeeded` no-op +
    // forensic audit on null tx.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_succeeded');
    // No state mutation.
    expect(deps.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    // Forensic audit on null tx (best-effort) so ops sees the anomaly.
    // H-11: dedicated event type instead of reusing
    // payment_processor_retrieve_failed; payload key renamed from
    // `processor_error_kind` to `mismatch_kind` for clarity.
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'payment_acknowledged_terminal_state',
        payload: expect.objectContaining({
          mismatch_kind: 'illegal_transition',
          from_status: 'partially_refunded',
        }),
      }),
    );
  });

  it('invariant violation — duplicate succeeded payment on same invoice → ack pattern (H-3 review 2026-04-27)', async () => {
    // H-3: previously returned err({code:'invariant_violation_duplicate_succeeded'})
    // which 5xx-ed the webhook → Stripe retried for 72h. Now mirrors
    // the illegal_transition ack pattern: markProcessed + forensic
    // audit + return ok({ kind:'already_succeeded' }) so Stripe sees
    // 200 and stops retrying on a permanent state mismatch.
    const deps = makeDeps();
    (deps.paymentsRepo.listSiblingStatusesForInvariant as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ['succeeded'],
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_succeeded');
    // Forensic audit must fire on null-tx (best-effort outside the
    // about-to-roll-back tx).
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const invariantAuditCall = auditCalls.find(
      (c) =>
        c[1].eventType === 'payment_acknowledged_terminal_state' &&
        c[1].payload?.mismatch_kind === 'invariant_violation_duplicate_succeeded',
    );
    expect(invariantAuditCall).toBeDefined();
    // T-A (review 2026-04-27): pin from_status so a regression in
    // `_shared.emitTerminalStateAck` (e.g. losing the field or emitting
    // undefined) is caught here rather than slipping into prod audits.
    expect(invariantAuditCall![1].payload.from_status).toBe('pending');
  });

  it('retrievePaymentIntent failure — processor_unavailable', async () => {
    const deps = makeDeps();
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('processor_unavailable');
  });

  it('F4 markPaid failure — bridge_error with detail', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'some_f4_error', detail: 'whatever' }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('bridge_error');
  });

  // REMOVE-WITH-064-REMEDIATION — S0 money-trap defence-in-depth. An
  // IN-FLIGHT PI (created before the initiate-side guard deployed) can
  // still confirm against a LEGACY issued no-TIN event invoice. The F4
  // payability read now rejects those rows with
  // `legacy_no_tin_event_not_payable`; the webhook must treat that
  // EXACTLY like the pre-guard `issued` read (NO auto-refund — the
  // member genuinely owes the fee) and let the markPaid-side
  // `legacy_no_tin_event_needs_remediation` guard fail the flip — but
  // LOUDLY: ops must see a dedicated error log telling them money was
  // captured against a row the runbook has to reconcile. Delete with
  // the master checklist in record-payment.ts.
  it('legacy no-TIN event invoice in-flight webhook — no auto-refund, bridge_error, LOUD ops log (REMOVE-WITH-064-REMEDIATION)', async () => {
    const { logger } = await import('@/lib/logger');
    const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps();
      (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        err({ code: 'legacy_no_tin_event_not_payable' }),
      );
      (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        err({
          code: 'legacy_no_tin_event_needs_remediation',
          detail: 'unknown_f4_error_shape (code=legacy_no_tin_event_needs_remediation)',
        }),
      );

      const result = await confirmPayment(deps, INPUT);

      // The webhook flow CONTINUED past the payability read (treated as
      // status='issued') — it must NOT enter the stale-invoice
      // auto-refund branch.
      expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
      // The payment row was flipped to succeeded (money IS captured) —
      // this is the state the ops log + runbook reconcile.
      expect(deps.paymentsRepo.updateStatus).toHaveBeenCalledTimes(1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('bridge_error');
      if (result.error.code !== 'bridge_error') return;
      expect(result.error.detail).toBe('legacy_no_tin_event_needs_remediation');

      // LOUD ops signal: dedicated logger.error naming the runbook class.
      const legacyLogCall = loggerErrorSpy.mock.calls.find(
        (c) => c[1] === 'payments.confirm.legacy_no_tin_event_money_captured',
      );
      expect(legacyLogCall).toBeDefined();
      const ctx = legacyLogCall![0] as Record<string, unknown>;
      expect(ctx['tenantId']).toBe(TENANT_ID);
      expect(ctx['invoiceId']).toBe(PENDING_PAYMENT.invoiceId);
      expect(ctx['paymentIntentId']).toBe(PAYMENT_INTENT_ID);
    } finally {
      loggerErrorSpy.mockRestore();
    }
  });

  it('overdue invoice — still processes (payable status)', async () => {
    // F4 models "overdue" as a derived state — the InvoiceStatus enum
    // has no `'overdue'` value; an overdue invoice carries
    // `status='issued'` + a past due_date. Architect D-04 follow-up
    // (2026-04-24): this test previously used the non-existent
    // 'overdue' status which slipped through via an unsafe cast in
    // the use-case; the cleaned-up type narrowing exposed the gap.
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'issued' as const,
        totalSatang: asSatang(5_350_000n),
        memberId: 'mem_01J_MEM',
        tenantId: TENANT_ID,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
  });

  it('card metadata included in audit payload when retrievePaymentIntent returns card', async () => {
    const deps = makeDeps();
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const succeededCall = auditCalls.find((c) => c[1].eventType === 'payment_succeeded');
    expect(succeededCall?.[1].payload.card_brand).toBe('visa');
    expect(succeededCall?.[1].payload.card_last4).toBe('4242');
  });

  it('no card (promptpay) in retrievePaymentIntent — audit without card fields', async () => {
    const deps = makeDeps();
    (deps.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: PAYMENT_INTENT_ID,
        status: 'succeeded',
        latestChargeId: 'ch_test_123',
        livemode: false,
        lastPaymentErrorCode: null,
        card: null,
      }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const succeededCall = auditCalls.find((c) => c[1].eventType === 'payment_succeeded');
    expect(succeededCall?.[1].payload.card_brand).toBeUndefined();
  });

  it('promptpay payment.method maps to "stripe_promptpay" on F4 markPaid bridge call (vs "stripe_card")', async () => {
    // Branch coverage: confirm-payment.ts line ~387 has
    //   `payment.method === 'card' ? 'stripe_card' : 'stripe_promptpay'`
    // The default fixture uses method='card'; this test exercises the
    // promptpay arm so the bridge invocation is correct end-to-end.
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, method: 'promptpay' as const, card: null },
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    const bridgeCall = (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(bridgeCall?.method).toBe('stripe_promptpay');
  });
});
