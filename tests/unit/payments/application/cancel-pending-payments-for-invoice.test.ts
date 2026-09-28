/**
 * cancelPendingPaymentsForInvoice — the payments half of "voiding an invoice
 * cancels its live PaymentIntents" (follow-up to the #446 financial-integrity
 * review, M-a).
 *
 * Before this, `voidInvoice` never touched `payments`: a card PaymentIntent a
 * member had already opened stayed live at Stripe, the PaySheet kept its
 * `clientSecret` across drawer reopen, and a later confirm captured money for
 * a voided invoice that the webhook then auto-refunded days later.
 *
 * Per pending row the use-case mirrors `cancelPayment`'s two-phase shape
 * (lock + validate → Stripe cancel OUTSIDE any tx → re-lock + CAS update +
 * audit), minus the member role/ownership gate — the caller is the void.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok, err, type Result } from '@/lib/result';
import type { ProcessorGatewayError } from '@/modules/payments/application/ports/processor-gateway-port';
import {
  cancelPendingPaymentsForInvoice,
  type CancelPendingPaymentsForInvoiceDeps,
} from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';

const TENANT_ID = 'tnt_abc';
const INVOICE_ID = 'inv_void_1';
const ACTOR = 'usr_admin_1';

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

function pending(n: number, overrides: Partial<Payment> = {}): Payment {
  return {
    id: asPaymentId(`pmt_${n}`),
    tenantId: TENANT_ID,
    invoiceId: INVOICE_ID,
    memberId: 'mem_1',
    method: 'card',
    status: 'pending',
    amountSatang: asSatang(107_000n),
    currency: 'THB',
    processorPaymentIntentId: `pi_${n}`,
    processorChargeId: null,
    processorEnvironment: 'test',
    attemptSeq: n,
    card: null,
    failureReasonCode: null,
    initiatedAt: new Date(0),
    completedAt: null,
    actorUserId: 'usr_member_1',
    correlationId: `c${n}`,
    ...overrides,
  };
}

/** Rows keyed by id; lockForUpdate returns the CURRENT row (tests mutate it). */
function makeDeps(rows: Payment[]) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  const audit = { emit: vi.fn(async (_tx: unknown, _event: unknown) => undefined) };
  const paymentsRepo = {
    withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({ tx: true })),
    acquireInitiateLock: vi.fn(async (_tx: unknown, _t: string, _i: string) => undefined),
    listPendingByInvoice: vi.fn(async (_t: string, _i: string, _tx?: unknown) => rows),
    lockForUpdate: vi.fn(async (_tx: unknown, id: string) => byId.get(id) ?? null),
    updateStatus: vi.fn(async (_tx: unknown, u: { paymentId: string; nextStatus: string }) => {
      const cur = byId.get(u.paymentId)!;
      const next = { ...cur, status: u.nextStatus } as Payment;
      byId.set(u.paymentId, next);
      return next;
    }),
  };
  const processorGateway = {
    cancelPaymentIntent: vi.fn(
      async (_pi: string, _acct: string): Promise<Result<void, ProcessorGatewayError>> => ok(undefined),
    ),
  };
  const tenantSettingsRepo = {
    getByTenantId: vi.fn(async () => SETTINGS_OK),
    findByProcessorAccountId: vi.fn(),
  };
  const deps = {
    paymentsRepo,
    processorGateway,
    tenantSettingsRepo,
    audit,
    clock: { nowIso: () => '1970-01-01T00:00:00.000Z', nowMs: () => 0 },
  } as unknown as CancelPendingPaymentsForInvoiceDeps;
  return { deps, byId, audit, paymentsRepo, processorGateway, tenantSettingsRepo };
}

const INPUT = {
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  actorUserId: ACTOR,
  cause: 'invoice_voided' as const,
  requestId: 'req-1',
};

function auditTypes(audit: { emit: ReturnType<typeof vi.fn> }): string[] {
  return audit.emit.mock.calls.map((c) => (c[1] as { eventType: string }).eventType);
}

describe('cancelPendingPaymentsForInvoice', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no pending rows → no-op: no Stripe call, no settings read, no audit', async () => {
    const h = makeDeps([]);
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 0, failed: 0 });
    expect(h.processorGateway.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(h.tenantSettingsRepo.getByTenantId).not.toHaveBeenCalled();
    expect(h.audit.emit).not.toHaveBeenCalled();
    expect(h.paymentsRepo.listPendingByInvoice).toHaveBeenCalledWith(TENANT_ID, INVOICE_ID, { tx: true });
  });

  it('lists pending rows under initiate\'s advisory lock, in the same tx (an in-flight initiate commits first)', async () => {
    const h = makeDeps([]);
    await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(h.paymentsRepo.acquireInitiateLock).toHaveBeenCalledWith({ tx: true }, TENANT_ID, INVOICE_ID);
    expect(h.paymentsRepo.acquireInitiateLock.mock.invocationCallOrder[0]!).toBeLessThan(
      h.paymentsRepo.listPendingByInvoice.mock.invocationCallOrder[0]!,
    );
  });

  it('two pending rows → both canceled at Stripe (tenant account) then locally, one payment_canceled each', async () => {
    const h = makeDeps([pending(1), pending(2, { method: 'promptpay' })]);
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 2, skipped: 0, failed: 0 });
    expect(h.processorGateway.cancelPaymentIntent.mock.calls).toEqual([
      ['pi_1', 'acct_test_123'],
      ['pi_2', 'acct_test_123'],
    ]);
    expect(h.byId.get('pmt_1')!.status).toBe('canceled');
    expect(h.byId.get('pmt_2')!.status).toBe('canceled');
    // CAS update: the WHERE must carry the status Phase B observed.
    expect(h.paymentsRepo.updateStatus).toHaveBeenCalledWith(
      { tx: true },
      expect.objectContaining({
        paymentId: 'pmt_1',
        tenantId: TENANT_ID,
        nextStatus: 'canceled',
        expectedCurrentStatus: 'pending',
      }),
    );
    expect(auditTypes(h.audit)).toEqual(['payment_canceled', 'payment_canceled']);
    const first = h.audit.emit.mock.calls[0]!;
    // Committed atomically with the status flip (tx, not null).
    expect(first[0]).toEqual({ tx: true });
    expect(first[1]).toMatchObject({
      tenantId: TENANT_ID,
      requestId: 'req-1',
      actorUserId: ACTOR,
      payload: {
        payment_id: 'pmt_1',
        invoice_id: INVOICE_ID,
        actor_type: 'system',
        cause: 'invoice_voided',
      },
      retentionYears: 5,
    });
  });

  it('Stripe says already succeeded → row left untouched for the webhook stale-invoice auto-refund; no cancel audit', async () => {
    const h = makeDeps([pending(1)]);
    h.processorGateway.cancelPaymentIntent.mockResolvedValueOnce(
      err({ kind: 'permanent', code: 'payment_intent_already_succeeded', reason: 'succeeded' }),
    );
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 1, failed: 0 });
    expect(h.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(h.byId.get('pmt_1')!.status).toBe('pending');
    expect(auditTypes(h.audit)).toEqual([]);
  });

  it('retryable Stripe failure → row stays pending, payment_cancel_attempt_failed on a null tx, next row still processed', async () => {
    const h = makeDeps([pending(1), pending(2)]);
    h.processorGateway.cancelPaymentIntent.mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'stripe 503' }),
    );
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 1, skipped: 0, failed: 1 });
    expect(h.byId.get('pmt_1')!.status).toBe('pending');
    expect(h.byId.get('pmt_2')!.status).toBe('canceled');
    const failedCall = h.audit.emit.mock.calls.find(
      (c) => (c[1] as { eventType: string }).eventType === 'payment_cancel_attempt_failed',
    )!;
    expect(failedCall[0]).toBeNull();
    expect(failedCall[1]).toMatchObject({
      payload: {
        payment_id: 'pmt_1',
        invoice_id: INVOICE_ID,
        actor_type: 'system',
        processor_error_kind: 'retryable',
      },
    });
  });

  it('webhook canceled the row between phases → idempotent: counted canceled, no second payment_canceled', async () => {
    const h = makeDeps([pending(1)]);
    h.processorGateway.cancelPaymentIntent.mockImplementationOnce(async () => {
      // payment_intent.canceled webhook lands while we are at Stripe.
      h.byId.set('pmt_1', { ...h.byId.get('pmt_1')!, status: 'canceled' });
      return ok(undefined);
    });
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 1, skipped: 0, failed: 0 });
    expect(h.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(auditTypes(h.audit)).toEqual([]);
  });

  it('row succeeded between phases → never overwritten to canceled; forensic attempt_failed, counted failed', async () => {
    const h = makeDeps([pending(1)]);
    h.processorGateway.cancelPaymentIntent.mockImplementationOnce(async () => {
      h.byId.set('pmt_1', { ...h.byId.get('pmt_1')!, status: 'succeeded' });
      return ok(undefined);
    });
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 0, failed: 1 });
    expect(h.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(h.byId.get('pmt_1')!.status).toBe('succeeded');
    expect(auditTypes(h.audit)).toEqual(['payment_cancel_attempt_failed']);
  });

  it('row no longer pending at Phase A (listed pending, then moved on) → skipped, no Stripe call', async () => {
    const h = makeDeps([pending(1)]);
    h.paymentsRepo.lockForUpdate.mockResolvedValueOnce({ ...pending(1), status: 'failed' });
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 1, failed: 0 });
    expect(h.processorGateway.cancelPaymentIntent).not.toHaveBeenCalled();
  });

  it('tenant payment settings missing → every pending row counted failed, no Stripe call, forensic audit per row', async () => {
    const h = makeDeps([pending(1), pending(2)]);
    h.tenantSettingsRepo.getByTenantId.mockResolvedValueOnce(null as never);
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 0, failed: 2 });
    expect(h.processorGateway.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(auditTypes(h.audit)).toEqual([
      'payment_cancel_attempt_failed',
      'payment_cancel_attempt_failed',
    ]);
  });

  it('card PaymentIntent still processing (Stripe refuses cancel, permanent) → row stays pending, attempt_failed, counted failed', async () => {
    const h = makeDeps([pending(1)]);
    h.processorGateway.cancelPaymentIntent.mockResolvedValueOnce(
      err({ kind: 'permanent', code: 'payment_intent_unexpected_state', reason: 'processing' }),
    );
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 0, failed: 1 });
    expect(h.byId.get('pmt_1')!.status).toBe('pending');
    expect(h.paymentsRepo.updateStatus).not.toHaveBeenCalled();
    expect(auditTypes(h.audit)).toEqual(['payment_cancel_attempt_failed']);
  });

  it('Phase B lock miss after a successful Stripe cancel → forensic attempt_failed, counted failed', async () => {
    const h = makeDeps([pending(1)]);
    h.processorGateway.cancelPaymentIntent.mockImplementationOnce(async () => {
      h.byId.delete('pmt_1');
      return ok(undefined);
    });
    const r = await cancelPendingPaymentsForInvoice(h.deps, INPUT);
    expect(r).toEqual({ canceled: 0, skipped: 0, failed: 1 });
    expect(auditTypes(h.audit)).toEqual(['payment_cancel_attempt_failed']);
  });
});
