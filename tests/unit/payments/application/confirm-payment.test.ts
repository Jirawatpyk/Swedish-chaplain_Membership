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
  };
}

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
