/**
 * F-2 (money-remediation Task 3) — forensic emits in both Phase-B catches.
 *
 * ## The bug these pin
 *
 * Both Phase-B blocks in `confirmPayment` run AFTER `processorGateway
 * .createRefund` has already moved real money. The single transaction that
 * records that movement (`markAutoRefunded` / `attachAutoRefundMarkerIfAbsent`
 * + the 10-year money-trail audit + `markProcessed`) is wrapped in a
 * `try`/`catch` that swallowed the failure, bumped a counter, wrote a pino
 * line, and returned `ok(...)` — a 200 to Stripe.
 *
 * The result was a real refund with **no audit row at all**: the in-tx emit
 * rolled back with everything else, and pino rolls off in 30 days. Thai RD
 * §87/3 requires that record for 10 years.
 *
 * ## Why the obvious assertion does not work
 *
 * `expect(auditEmit).toHaveBeenCalledWith(objectContaining({ eventType }))`
 * passes against the UNFIXED code, because the in-tx emit at
 * `confirm-payment.ts:994` is recorded by the spy before the transaction
 * rejects. The spy cannot see a rollback. So every test here asserts on
 * `emitsOnNullTx(...)` — calls whose first argument is literally `null`, the
 * only ones that survive the unwind — and uses the rollback-capable double
 * from `tests/support/fake-tx.ts` to prove the in-tx row really is gone.
 *
 * ## The four-case matrix, run against both paths
 *
 *   1. tx commits                → 0 null-tx forensics (no duplicate row)
 *   2. tx throws                 → exactly 1, carrying the `re_…` id
 *   3. tx commits, POST-commit
 *      step throws               → 0 (the divergence signal is keyed on the
 *                                  transaction outcome, not on reaching the
 *                                  catch — see `phaseBCommitted`)
 *   4. tx throws AND the
 *      forensic emit throws      → swallowed; the 200-ack still happens
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok } from '@/lib/result';
import { paymentsMetrics } from '@/lib/metrics';
import { confirmPayment, type ConfirmPaymentDeps } from '@/modules/payments';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';
import {
  makeFakeTxRunner,
  recordWrite,
  expectRolledBack,
  type FakeTxRunner,
} from '../../../support/fake-tx';

const TENANT_ID = 'tnt_abc';
const PAYMENT_INTENT_ID = 'pi_test_abc';
const REFUND_ID = 're_test_auto';

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

/** The late-charge (#8 resume-race) subject: terminal `failed` row. */
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

type AuditCall = [unknown, { eventType: string; payload: Record<string, unknown>; retentionYears: number }];

interface Harness {
  deps: ConfirmPaymentDeps;
  runner: FakeTxRunner;
  warn: ReturnType<typeof vi.fn>;
  /** Only the emits that survive a transaction unwind. */
  emitsOnNullTx(eventType: string): AuditCall[];
}

/**
 * @param failInTxEmit  simulate the F-2 trigger — a Neon drop while the
 *                      in-transaction money-trail INSERT is in flight. The
 *                      write is RECORDED first, so `expectRolledBack` can
 *                      prove it was attempted and then discarded.
 * @param failNullTxEmit simulate an audit-rail outage co-occurring with the
 *                      DB outage (likely — both are Neon).
 */
function makeHarness(
  opts: { failInTxEmit?: boolean; failNullTxEmit?: boolean } = {},
): Harness {
  const runner = makeFakeTxRunner();

  const auditEmit = vi.fn(async (tx: unknown, event: { eventType: string }) => {
    if (tx === null) {
      if (opts.failNullTxEmit === true) {
        throw new Error('audit rail down');
      }
      return;
    }
    recordWrite(tx, `audit.emit:${event.eventType}`);
    if (opts.failInTxEmit === true) {
      throw new Error('neon: connection terminated unexpectedly');
    }
  });

  const paymentsRepo = {
    withTx: runner.withTx,
    lockForUpdate: vi.fn(),
    lockForUpdateByPaymentIntentId: vi.fn(async () => PENDING_PAYMENT),
    insert: vi.fn(),
    updateStatus: vi.fn(async () => ({ ...PENDING_PAYMENT, status: 'succeeded' as const })),
    markAutoRefunded: vi.fn(async (tx: unknown) => {
      recordWrite(tx, 'payments.markAutoRefunded');
      return {
        ...PENDING_PAYMENT,
        status: 'auto_refunded' as const,
        completedAt: new Date('2026-05-12T07:00:00.000Z'),
        autoRefundProcessorRefundId: REFUND_ID,
      };
    }),
    attachAutoRefundMarkerIfAbsent: vi.fn(async (tx: unknown) => {
      recordWrite(tx, 'payments.attachAutoRefundMarkerIfAbsent');
      return {
        ...PENDING_PAYMENT,
        status: 'failed' as const,
        completedAt: new Date('2026-05-12T06:30:00.000Z'),
        failureReasonCode: 'card_declined',
        autoRefundProcessorRefundId: REFUND_ID,
      };
    }),
    findPendingByInvoiceAndActor: vi.fn(),
    listSiblingStatusesForInvariant: vi.fn(async () => []),
    nextAttemptSeq: vi.fn(),
  };

  const warn = vi.fn();

  const deps = {
    paymentsRepo: paymentsRepo as unknown as ConfirmPaymentDeps['paymentsRepo'],
    tenantSettingsRepo: {
      getByTenantId: vi.fn(async () => SETTINGS_OK),
      findByProcessorAccountId: vi.fn(),
    } as unknown as ConfirmPaymentDeps['tenantSettingsRepo'],
    processorGateway: {
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
        ok({ id: REFUND_ID, status: 'succeeded', amountSatang: asSatang(5_350_000n) }),
      ),
    } as unknown as ConfirmPaymentDeps['processorGateway'],
    invoicingBridge: {
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
    } as unknown as ConfirmPaymentDeps['invoicingBridge'],
    audit: { emit: auditEmit } as unknown as ConfirmPaymentDeps['audit'],
    clock: {
      nowIso: () => '2026-05-12T07:00:00.000Z',
      nowMs: () => 1_747_033_200_000,
    },
    logger: { warn: warn as (msg: string, ctx: Record<string, unknown>) => void },
    taxAtPayment: 'off' as const,
  };

  return {
    deps,
    runner,
    warn,
    emitsOnNullTx(eventType: string) {
      return (auditEmit.mock.calls as unknown as AuditCall[]).filter(
        (c) => c[0] === null && c[1].eventType === eventType,
      );
    },
  };
}

/** Drive the stale-invoice Phase B: invoice already `paid` → concurrent-manual-mark. */
function makeStale(opts?: Parameters<typeof makeHarness>[0]): Harness {
  const h = makeHarness(opts);
  (h.deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValue(
    ok({
      id: 'inv_01JABCDE_XYZ',
      status: 'paid' as const,
      totalSatang: asSatang(5_350_000n),
      memberId: 'mem_01J_MEM',
      tenantId: TENANT_ID,
    }),
  );
  return h;
}

/** Drive the late-charge Phase B: the locked row is terminal `failed`. */
function makeLateCharge(opts?: Parameters<typeof makeHarness>[0]): Harness {
  const h = makeHarness(opts);
  (
    h.deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>
  ).mockResolvedValue(FAILED_PAYMENT);
  return h;
}

const STALE_EVENT = 'payment_auto_refunded_concurrent_manual_mark';
const LATE_CHARGE_EVENT = 'payment_auto_refunded_stale_invoice';

describe('F-2 — Phase B forensic emit (stale-invoice auto-refund)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('case 2 — tx throws after the refund settled: exactly ONE null-tx forensic survives, carrying the re_… id', async () => {
    const h = makeStale({ failInTxEmit: true });

    const result = await confirmPayment(h.deps, INPUT);

    // ── the money assertion, first ──────────────────────────────────────
    // Stripe moved ฿53,500 and the ONLY transaction that recorded it died.
    // Without a null-tx emit the refund has no audit row anywhere.
    const forensics = h.emitsOnNullTx(STALE_EVENT);
    expect(forensics).toHaveLength(1);
    const payload = forensics[0]![1].payload;
    expect(payload.processor_refund_id).toBe(REFUND_ID);
    expect(payload.payment_id).toBe(PENDING_PAYMENT.id);
    expect(payload.invoice_id).toBe(PENDING_PAYMENT.invoiceId);
    expect(payload.refunded_amount_satang).toBe('5350000');
    expect(payload.cause).toBe('invoice_already_paid');
    // RD §87/3 — this row is the 10-year money trail.
    expect(forensics[0]![1].retentionYears).toBe(10);

    // ── F-2 part 2: the recovery claim ─────────────────────────────────
    // `awaiting_stripe_retry_idempotency` was false: the function returns
    // `ok`, the route 200-acks, and Stripe does not redeliver a 2xx. The
    // only real recovery is a human with the runbook.
    expect(payload.recovery).toBe('manual_reconcile_via_runbook');
    expect(payload.runbook_url).toBe('docs/runbooks/out-of-band-refund.md');
    expect(h.warn).toHaveBeenCalledWith(
      'confirm_payment.stale_refund_phase_b_mark_failed',
      expect.objectContaining({ recovery: 'manual_reconcile_via_runbook' }),
    );

    // ── the in-tx row really is gone ───────────────────────────────────
    // Proves the null-tx emit is not merely redundant with the in-tx one.
    expectRolledBack(h.runner, 'payments.markAutoRefunded');
    expectRolledBack(h.runner, `audit.emit:${STALE_EVENT}`);

    // 200-ack behaviour is UNCHANGED by this task (F-2 part 3 is Task 5).
    expect(result.ok).toBe(true);
  });

  it('case 1 — tx commits: no null-tx forensic (a duplicate 10y row would double-list the reconcile surface)', async () => {
    const h = makeStale();

    const result = await confirmPayment(h.deps, INPUT);

    expect(h.emitsOnNullTx(STALE_EVENT)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('case 3 — tx COMMITS but a post-commit step throws: still no forensic (the signal is keyed on the tx, not on the catch)', async () => {
    const h = makeStale();
    vi.spyOn(paymentsMetrics, 'autoRefundedStaleCount').mockImplementation(() => {
      throw new Error('otel meter exploded');
    });

    const result = await confirmPayment(h.deps, INPUT);

    // The money trail committed. A forensic here would be a SECOND
    // 10-year row for one refund — and `findStaleInvoiceAutoRefund`
    // would list the reconcile task twice.
    expect(h.emitsOnNullTx(STALE_EVENT)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('case 4 — the forensic emit itself throws: swallowed, the 200-ack still happens', async () => {
    const h = makeStale({ failInTxEmit: true, failNullTxEmit: true });

    // An audit-rail outage co-occurring with the DB outage is likely (both
    // are Neon). Converting a swallowed 200 into a thrown 500 is a
    // different failure, not a fix.
    const result = await confirmPayment(h.deps, INPUT);

    expect(result.ok).toBe(true);
  });

  it('deps.logger absent — the forensic still lands (the trail must not depend on optional wiring)', async () => {
    const h = makeStale({ failInTxEmit: true });
    // Omit rather than set-undefined — `exactOptionalPropertyTypes` is on.
    const { logger: _omitted, ...depsNoLogger } = h.deps;

    const result = await confirmPayment(depsNoLogger, INPUT);

    expect(h.emitsOnNullTx(STALE_EVENT)).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});

describe('F-2 — Phase B forensic emit (late-charge auto-refund)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('case 2 — tx throws after the refund settled: exactly ONE null-tx forensic survives, carrying the re_… id', async () => {
    const h = makeLateCharge({ failInTxEmit: true });

    const result = await confirmPayment(h.deps, INPUT);

    const forensics = h.emitsOnNullTx(LATE_CHARGE_EVENT);
    expect(forensics).toHaveLength(1);
    const payload = forensics[0]![1].payload;
    expect(payload.processor_refund_id).toBe(REFUND_ID);
    expect(payload.payment_id).toBe(FAILED_PAYMENT.id);
    expect(payload.cause).toBe('payment_terminal_failed_late_charge');
    expect(payload.refunded_amount_satang).toBe('5350000');
    expect(forensics[0]![1].retentionYears).toBe(10);

    expect(payload.recovery).toBe('manual_reconcile_via_runbook');
    expect(payload.runbook_url).toBe('docs/runbooks/out-of-band-refund.md');
    expect(h.warn).toHaveBeenCalledWith(
      'confirm_payment.late_charge_phase_b_mark_failed',
      expect.objectContaining({ recovery: 'manual_reconcile_via_runbook' }),
    );

    expectRolledBack(h.runner, 'payments.attachAutoRefundMarkerIfAbsent');
    expectRolledBack(h.runner, `audit.emit:${LATE_CHARGE_EVENT}`);

    expect(result.ok).toBe(true);
  });

  it('case 1 — tx commits: no null-tx forensic', async () => {
    const h = makeLateCharge();

    const result = await confirmPayment(h.deps, INPUT);

    expect(h.emitsOnNullTx(LATE_CHARGE_EVENT)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('case 3 — tx COMMITS but a post-commit step throws: still no forensic', async () => {
    const h = makeLateCharge();
    vi.spyOn(paymentsMetrics, 'lateChargeAutoRefundedCount').mockImplementation(() => {
      throw new Error('otel meter exploded');
    });

    const result = await confirmPayment(h.deps, INPUT);

    expect(h.emitsOnNullTx(LATE_CHARGE_EVENT)).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('case 4 — the forensic emit itself throws: swallowed, the 200-ack still happens', async () => {
    const h = makeLateCharge({ failInTxEmit: true, failNullTxEmit: true });

    const result = await confirmPayment(h.deps, INPUT);

    expect(result.ok).toBe(true);
  });

  it('deps.logger absent — the forensic still lands (unit callers do not wire a logger)', async () => {
    const h = makeLateCharge({ failInTxEmit: true });
    // Omit rather than set-undefined — `exactOptionalPropertyTypes` is on.
    const { logger: _omitted, ...depsNoLogger } = h.deps;

    const result = await confirmPayment(depsNoLogger, INPUT);

    expect(h.emitsOnNullTx(LATE_CHARGE_EVENT)).toHaveLength(1);
    expect(result.ok).toBe(true);
  });
});
