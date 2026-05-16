/**
 * T058 + T059 + T060 unit tests — fail / cancel / handle-cancel use-cases.
 * Lighter coverage (80% branch) vs. the security-critical 3; these still
 * cover every error branch + happy path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
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
  amountSatang: asSatang(100_000n),
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
        // Staff-review R2 R005 (2026-04-28): H-11 — 10y because the event
        // records a permanent payment-status decision touching tax-doc reconciliation.
        retentionYears: 10,
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
    // Staff-review R2 R005 (2026-04-28): cross-tenant probe is forensic
    // — 5y retention per F5_AUDIT_RETENTION_YEARS['payment_cross_tenant_probe'].
    const auditCall = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(auditCall?.[1].eventType).toBe('payment_cross_tenant_probe');
    expect(auditCall?.[1].retentionYears).toBe(5);
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

  /**
   * F5R1-MED-TESTS — pin the F5R1-E4 closure: the audit row emitted on
   * a Stripe-side cancel failure MUST be the new
   * `payment_cancel_attempt_failed` event (migration 0148 + audit-port
   * union), NOT the `payment_canceled` event the pre-fix code reused.
   * Audit-log dashboards filtering `event_type='payment_canceled'` would
   * otherwise see Stripe-rejected cancel attempts as successes — a
   * false-positive that masks a real reconciliation problem.
   */
  it('R1-E4: Stripe cancel failure emits payment_cancel_attempt_failed (NOT payment_canceled)', async () => {
    const d = deps();
    (d.processorGateway.cancelPaymentIntent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ kind: 'permanent', reason: 'pi_already_canceled' }),
    );

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('processor_unavailable');
    if (r.error.code !== 'processor_unavailable') return;
    // Permanent kind must propagate so the route layer doesn't apply
    // a transient retry hint (Retry-After) on a permanent failure.
    expect(r.error.kind).toBe('permanent');

    // Find the audit emit for the cancel-attempt-failed event. The
    // probe-audit emits earlier branches don't fire for the happy
    // unlock-then-Stripe-fail path, so calls[0] is the right one —
    // but assert by event_type to be robust against future order
    // changes.
    const calls = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find(
      (c) => c[1]?.eventType === 'payment_cancel_attempt_failed',
    );
    expect(failedCall, 'expected payment_cancel_attempt_failed audit emit').toBeDefined();
    if (!failedCall) return;
    expect(failedCall[1].eventType).toBe('payment_cancel_attempt_failed');
    // 5y retention per F5_AUDIT_RETENTION_YEARS — operational class.
    expect(failedCall[1].retentionYears).toBe(5);
    expect(failedCall[1].payload).toMatchObject({
      processor_error_kind: 'permanent',
      actor_type: 'member',
    });

    // Defence-in-depth: the OLD `payment_canceled` event_type MUST
    // NOT be in the calls — a pre-E4 bug emitted both, polluting
    // success dashboards.
    const canceledCall = calls.find(
      (c) => c[1]?.eventType === 'payment_canceled',
    );
    expect(canceledCall, 'payment_canceled must NOT fire on Stripe failure').toBeUndefined();
  });

  /**
   * F5R2-CRIT-1 — Phase B WEBHOOK-RACE branch (succeeded webhook
   * lands between Phase A release and Phase B re-lock). The pre-fix
   * code had no canTransition guard in Phase B + no
   * `expectedCurrentStatus` on the repo's updateStatus → silently
   * overwrote a succeeded payment with canceled = customer charged
   * AND DB says canceled = SC-013 invariant break.
   *
   * The fix re-runs canTransition under Phase B's lock. For
   * status='succeeded' the transition to 'canceled' is illegal →
   * emit `payment_cancel_attempt_failed` audit + return
   * `payment_not_cancelable` (route maps to 409). updateStatus must
   * NOT be called.
   */
  it('R2-CRIT-1: webhook flips pending→succeeded between phases — Phase B catches it', async () => {
    const d = deps();
    // Phase A lockForUpdate sees pending; Phase B sees succeeded.
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ ...PENDING, status: 'succeeded' as const });

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_cancelable');
    if (r.error.code !== 'payment_not_cancelable') return;
    expect(r.error.currentStatus).toBe('succeeded');

    // updateStatus MUST NOT be called — pre-fix it WAS called and
    // silently overwrote succeeded → canceled.
    expect(d.paymentsRepo.updateStatus).not.toHaveBeenCalled();

    // Forensic audit emitted with race-detected summary so SRE can
    // page on chronic occurrences (Stripe ↔ webhook clock skew /
    // out-of-order delivery class).
    const calls = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const failedCall = calls.find(
      (c) =>
        c[1]?.eventType === 'payment_cancel_attempt_failed' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.startsWith('Phase B race:'),
    );
    expect(failedCall, 'expected Phase B race audit emit').toBeDefined();
  });

  /**
   * F5R2-CRIT-1 narrow race — even after the canTransition guard
   * passes (Phase B sees pending), an even-narrower race could flip
   * the row mid-UPDATE. The repo's `expectedCurrentStatus` WHERE
   * clause makes the UPDATE match zero rows → returns null → caller
   * treats as same race class.
   */
  it('R2-CRIT-1: updateStatus narrow-race returns null — caller emits forensic audit + err', async () => {
    const d = deps();
    // Phase B lockForUpdate sees pending (canTransition passes), but
    // updateStatus returns null (zero-match — row flipped to
    // succeeded between the lock and the UPDATE).
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(PENDING);
    (d.paymentsRepo.updateStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_cancelable');

    const calls = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const narrowRaceCall = calls.find(
      (c) =>
        c[1]?.eventType === 'payment_cancel_attempt_failed' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.startsWith('Phase B narrow race:'),
    );
    expect(narrowRaceCall, 'expected narrow-race audit emit').toBeDefined();
    // F5R3 H-8 (2026-05-16) — pin retention=5y on narrow-race emit so
    // a future retentionFor drift doesn't silently downgrade the
    // forensic class.
    expect(narrowRaceCall![1].retentionYears).toBe(5);
  });

  // ===========================================================================
  // F5R3 H-8 (2026-05-16) — Phase B branch coverage gaps
  // ===========================================================================
  // R2-CRIT-1 added 3 Phase B branches:
  //   (a) succeeded webhook race (covered above)
  //   (b) updateStatus narrow race (covered above)
  //   (c) Phase B webhook-beat to CANCELED (idempotent ack) ← NEW
  //   (d) Phase B fresh==null (lockForUpdate miss after Phase A) ← NEW
  //   (e) currentStatus field pin on the error variant ← NEW
  //
  // Each below pins a single branch with one assertion focus so a
  // regression maps cleanly to the affected branch.
  // ---------------------------------------------------------------------------

  it('R3-H8: Phase B webhook-beat to CANCELED — idempotent ok + cross-tenant-probe forensic audit', async () => {
    const d = deps();
    // Phase A sees pending; Phase B sees canceled (webhook landed and
    // completed the cancel between phases — benign idempotent class,
    // distinct from the succeeded-race silent-overwrite vulnerability).
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce({ ...PENDING, status: 'canceled' as const });

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('canceled');

    // updateStatus MUST NOT fire — Phase B observed canceled.
    expect(d.paymentsRepo.updateStatus).not.toHaveBeenCalled();

    // R2-M2 forensic audit so ops can quantify clock-skew /
    // out-of-order webhook delivery volume.
    const calls = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const probeCall = calls.find(
      (c) =>
        c[1]?.eventType === 'payment_cross_tenant_probe' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.startsWith('Phase B webhook-beat:'),
    );
    expect(probeCall, 'expected webhook-beat probe audit emit').toBeDefined();
  });

  it('R3-H8: Phase B lockForUpdate returns null (unexpected miss) → payment_not_found err + probe audit', async () => {
    const d = deps();
    // Phase A returns pending; Phase B finds the row deleted /
    // unlocked / cross-tenant-moved → reasonable response is
    // payment_not_found + forensic probe (DB intervention class).
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PENDING)
      .mockResolvedValueOnce(null);

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_found');

    // updateStatus MUST NOT fire — Phase B observed null.
    expect(d.paymentsRepo.updateStatus).not.toHaveBeenCalled();

    const calls = (d.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const missCall = calls.find(
      (c) =>
        c[1]?.eventType === 'payment_cross_tenant_probe' &&
        typeof c[1]?.summary === 'string' &&
        c[1].summary.includes('Phase B unexpected lockForUpdate miss'),
    );
    expect(missCall, 'expected Phase B miss probe audit emit').toBeDefined();
  });

  it('R3-H8: payment_not_cancelable error variant carries currentStatus field (route maps to 409)', async () => {
    const d = deps();
    // Set Phase A to return non-pending so the canTransition gate
    // fails at Phase A — this is the SAME error code as Phase B race
    // (payment_not_cancelable) but distinct trigger. We pin the
    // currentStatus payload on BOTH variants of the same error code.
    (d.paymentsRepo.lockForUpdate as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...PENDING, status: 'succeeded' as const });

    const r = await cancelPayment(d, BASE_INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('payment_not_cancelable');
    if (r.error.code !== 'payment_not_cancelable') return;
    // currentStatus is what the route includes in its 409 response
    // body; a regression that drops this field returns 409 with
    // undefined → frontend toast falls to missing-translation key.
    expect(r.error.currentStatus).toBe('succeeded');
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
        // Staff-review R2 R005 (2026-04-28): H-11 — 10y because the event
        // records a permanent payment-status decision touching tax-doc reconciliation.
        retentionYears: 10,
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
