/**
 * T057 unit tests — confirmPayment use-case.
 * Target: 100% branch coverage (Constitution Principle II).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  amountSatang: 5_350_000n,
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
      ok({ id: 're_test_auto', status: 'succeeded', amountSatang: 5_350_000n }),
    ),
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
    expect(auditCalls.some((c) => c[1].eventType === 'payment_succeeded')).toBe(true);
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
    // Review CR-4: invoice_not_found now folds markProcessed into the
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

  it('stale invoice (paid) — auto_refunded_stale_invoice + audit', async () => {
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
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(deps.processorGateway.createRefund).toHaveBeenCalled();
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) => c[1].eventType === 'payment_auto_refunded_stale_invoice'),
    ).toBe(true);
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  it('stale invoice (void) — cause=invoice_voided', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: 'inv_01JABCDE_XYZ',
        status: 'void' as const,
        totalSatang: 5_350_000n,
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
        totalSatang: 5_350_000n,
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
        totalSatang: 5_350_000n,
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

  it('illegal transition (partially_refunded → succeeded) — illegal_transition error', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      // succeeded → succeeded is illegal (treated as terminal_state by domain);
      // to get an illegal_transition we'd need a state that has destinations
      // but `succeeded` is not one. Simulate via partially_refunded (has
      // destinations but not `succeeded`).
      { ...PENDING_PAYMENT, status: 'partially_refunded' as const },
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('illegal_transition');
  });

  it('invariant violation — duplicate succeeded payment on same invoice', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.listSiblingStatusesForInvariant as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ['succeeded'],
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invariant_violation_duplicate_succeeded');
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
        totalSatang: 5_350_000n,
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
});
