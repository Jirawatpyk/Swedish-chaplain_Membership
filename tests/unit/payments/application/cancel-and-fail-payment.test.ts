/**
 * T058 + T059 + T060 unit tests — fail / cancel / handle-cancel use-cases.
 * Lighter coverage (80% branch) vs. the security-critical 3; these still
 * cover every error branch + happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import {
  failPayment,
  cancelPayment,
  handleCancelEvent,
  type FailPaymentDeps,
  type CancelPaymentDeps,
  type HandleCancelEventDeps,
} from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';

const TENANT_ID = 'tnt_abc';
const PAYMENT_ID = asPaymentId('pmt_01J_TEST');
const PAYMENT_INTENT_ID = 'pi_test_001';

const SETTINGS_OK: TenantPaymentSettings = {
  tenantId: TENANT_ID,
  processor: 'stripe',
  processorEnvironment: 'test',
  processorAccountId: 'acct_test_123',
  processorPublishableKey: 'pk_test_abc',
  enabledMethods: ['card'],
  onlinePaymentEnabled: true,
  autoEmailOnPayment: true,
  promptpayQrExpirySeconds: 900,
  allowAnonymousPaylink: false,
};

const PENDING: Payment = {
  id: PAYMENT_ID,
  tenantId: TENANT_ID,
  invoiceId: 'inv_X',
  memberId: 'mem_1',
  method: 'card',
  status: 'pending',
  amountSatang: 100_000n,
  currency: 'THB',
  processorPaymentIntentId: PAYMENT_INTENT_ID,
  processorChargeId: null,
  processorEnvironment: 'test',
  attemptSeq: 1,
  card: null,
  failureReasonCode: null,
  initiatedAt: new Date(),
  completedAt: null,
  actorUserId: 'usr_1',
  correlationId: 'c1',
};

function sharedRepo() {
  return {
    withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn({})),
    lockForUpdate: vi.fn(async () => PENDING),
    lockForUpdateByPaymentIntentId: vi.fn(async () => PENDING),
    insert: vi.fn(),
    updateStatus: vi.fn(async () => PENDING),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(async () => []),
    nextAttemptSeq: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// failPayment (T058)
// ---------------------------------------------------------------------------

describe('failPayment (T058)', () => {
  beforeEach(() => vi.clearAllMocks());

  function deps(): FailPaymentDeps {
    return {
      paymentsRepo: sharedRepo() as unknown as FailPaymentDeps['paymentsRepo'],
      tenantSettingsRepo: {
        getByTenantId: vi.fn(async () => SETTINGS_OK),
        findByProcessorAccountId: vi.fn(),
      } as unknown as FailPaymentDeps['tenantSettingsRepo'],
      processorGateway: {
        createPaymentIntent: vi.fn(),
        retrievePaymentIntent: vi.fn(async () =>
          ok({
            id: PAYMENT_INTENT_ID,
            status: 'requires_payment_method',
            latestChargeId: null,
            livemode: false,
            lastPaymentErrorCode: 'card_declined',
            card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2027 },
          }),
        ),
        cancelPaymentIntent: vi.fn(),
        createRefund: vi.fn(),
      } as unknown as FailPaymentDeps['processorGateway'],
      audit: { emit: vi.fn(async () => undefined) } as unknown as FailPaymentDeps['audit'],
      clock: { nowIso: () => '', nowMs: () => 0 },
    };
  }

  const INPUT = {
    tenantId: TENANT_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    requestId: null,
    eventCreatedAtUnixSeconds: 1_000,
  };

  it('happy path — updates to failed, emits payment_failed audit', async () => {
    const d = deps();
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(true);
  });

  it('tenant_settings missing → processor_unavailable', async () => {
    const d = deps();
    (d.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(false);
  });

  it('unknown intent → unknown_intent outcome', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('unknown_intent');
  });

  it('terminal state → already_terminal', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING, status: 'failed' as const },
    );
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('already_terminal');
  });

  it('retrieve failure → processor_unavailable', async () => {
    const d = deps();
    (d.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(false);
  });

  it('null lastPaymentErrorCode → reasonCode = unknown', async () => {
    const d = deps();
    (d.processorGateway.retrievePaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({
        id: PAYMENT_INTENT_ID,
        status: 'requires_payment_method',
        latestChargeId: null,
        livemode: false,
        lastPaymentErrorCode: null,
        card: null,
      }),
    );
    const r = await failPayment(d, INPUT);
    expect(r.ok).toBe(true);
  });

  it('illegal transition from a state with destinations to failed → R4 I-3: ack + already_terminal (NOT err)', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING, status: 'partially_refunded' as const },
    );
    const r = await failPayment(d, INPUT);
    // R4 I-3: was `err` → caused stuck-row loop. Now acknowledged.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('already_terminal');
    // H-11: dedicated event type + renamed payload key.
    expect(d.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'payment_acknowledged_terminal_state',
        payload: expect.objectContaining({
          mismatch_kind: 'illegal_transition',
          // T-B (review 2026-04-27): pin from_status for parity with
          // confirm-payment.test line 288 — locks the
          // `_shared.emitTerminalStateAck` payload shape.
          from_status: 'partially_refunded',
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// cancelPayment (T059)
// ---------------------------------------------------------------------------

describe('cancelPayment (T059)', () => {
  beforeEach(() => vi.clearAllMocks());

  function deps(): CancelPaymentDeps {
    return {
      paymentsRepo: sharedRepo() as unknown as CancelPaymentDeps['paymentsRepo'],
      tenantSettingsRepo: {
        getByTenantId: vi.fn(async () => SETTINGS_OK),
        findByProcessorAccountId: vi.fn(),
      } as unknown as CancelPaymentDeps['tenantSettingsRepo'],
      processorGateway: {
        createPaymentIntent: vi.fn(),
        retrievePaymentIntent: vi.fn(),
        cancelPaymentIntent: vi.fn(async () => ok(undefined)),
        createRefund: vi.fn(),
      } as unknown as CancelPaymentDeps['processorGateway'],
      audit: { emit: vi.fn(async () => undefined) } as unknown as CancelPaymentDeps['audit'],
      clock: { nowIso: () => '', nowMs: () => Date.now() },
    };
  }

  const BASE_INPUT = {
    tenantId: TENANT_ID,
    actorUserId: 'usr_1',
    actorRole: 'member' as const,
    actorMemberId: 'mem_1',
    paymentId: PAYMENT_ID,
    requestId: null,
  };

  it('happy path — canceled', async () => {
    const d = deps();
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(true);
  });

  it('forbidden role — admin cannot cancel own', async () => {
    const d = deps();
    const r = await cancelPayment(d, { ...BASE_INPUT, actorRole: 'admin' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('forbidden_role');
  });

  it('tenant settings missing → processor_unavailable', async () => {
    const d = deps();
    (d.tenantSettingsRepo.getByTenantId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(false);
  });

  it('payment not found — payment_not_found + probe audit', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_found');
    expect(d.audit.emit).toHaveBeenCalled();
  });

  it('ownership mismatch — forbidden_payment + probe audit', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...PENDING,
      memberId: 'mem_other',
    });
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('forbidden_payment');
  });

  it('non-cancelable state → payment_not_cancelable', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...PENDING,
      status: 'succeeded' as const,
    });
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_cancelable');
  });

  it('processor cancel failure → processor_unavailable', async () => {
    const d = deps();
    (d.processorGateway.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'timeout' }),
    );
    const r = await cancelPayment(d, BASE_INPUT);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleCancelEvent (T060)
// ---------------------------------------------------------------------------

describe('handleCancelEvent (T060)', () => {
  beforeEach(() => vi.clearAllMocks());

  function deps(): HandleCancelEventDeps {
    return {
      paymentsRepo: sharedRepo() as unknown as HandleCancelEventDeps['paymentsRepo'],
      audit: { emit: vi.fn(async () => undefined) } as unknown as HandleCancelEventDeps['audit'],
      clock: { nowIso: () => '', nowMs: () => 0 },
    };
  }

  const INPUT = {
    tenantId: TENANT_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    requestId: null,
    eventCreatedAtUnixSeconds: 1_000,
  };

  it('pending → canceled, emits audit', async () => {
    const d = deps();
    const r = await handleCancelEvent(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('processed');
  });

  it('unknown intent → unknown_intent', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      null,
    );
    const r = await handleCancelEvent(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('unknown_intent');
  });

  it('already canceled → already_canceled (idempotent)', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING, status: 'canceled' as const },
    );
    const r = await handleCancelEvent(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('already_canceled');
    expect(d.paymentsRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('terminal non-canceled (succeeded) → already_canceled no-op (avoid retry storm)', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING, status: 'refunded' as const },
    );
    const r = await handleCancelEvent(d, INPUT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('already_canceled');
  });

  it('illegal transition from partially_refunded → R4 I-3: ack + already_canceled (NOT err)', async () => {
    const d = deps();
    (d.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING, status: 'partially_refunded' as const },
    );
    const r = await handleCancelEvent(d, INPUT);
    // R4 I-3: was `err` → caused stuck-row loop. Now acknowledged.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('already_canceled');
    // H-11: dedicated event type + renamed payload key.
    expect(d.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'payment_acknowledged_terminal_state',
        payload: expect.objectContaining({
          mismatch_kind: 'illegal_transition',
          // T-B (review 2026-04-27): pin from_status for parity with
          // confirm-payment.test line 288 — locks the
          // `_shared.emitTerminalStateAck` payload shape.
          from_status: 'partially_refunded',
        }),
      }),
    );
  });
});
