/**
 * T057 unit tests — confirmPayment use-case.
 * Target: 100% branch coverage (Constitution Principle II).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { asSatang } from '@/lib/money';
import { ok, err } from '@/lib/result';
import {
  makeFakeTxRunner,
  recordWrite,
  expectRolledBack,
} from '../../../support/fake-tx';
import { confirmPayment, type ConfirmPaymentDeps } from '@/modules/payments';
// Deep import, deliberately: `causeForInvoiceStatus` is a use-case-internal
// pure helper exported for direct unit coverage — it is not part of the
// module's public barrel surface.
import { causeForInvoiceStatus } from '../../../../src/modules/payments/application/use-cases/confirm-payment';
import { asPaymentId, type Payment } from '../../../../src/modules/payments/domain/payment';
import type { TenantPaymentSettings } from '../../../../src/modules/payments/domain/tenant-payment-settings';
// NOT vi.mock'd in this file (other suites rely on the real module shape);
// individual tests vi.spyOn specific counters and restore them.
import { paymentsMetrics } from '@/lib/metrics';

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
    // A.15 (#8) — status-agnostic, status-preserving marker write. Default:
    // guard hits (marker NULL) → returns the row carrying the durable marker
    // (status NOT flipped). Shape a `failed` row by default (the most common
    // caller); sub-case (i) tests that need a different concurrent status
    // override the return per-test.
    attachAutoRefundMarkerIfAbsent: vi.fn(async () => ({
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
    // money-remediation Task 4 — flag OFF preserves the pre-remediation
    // commit-on-bridge-decline behaviour this suite was written against.
    settlementAbort: false,
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

  // POST-COMMIT F8 finalise hook — fired by invoice id AFTER the settlement tx
  // commits, on `processed` ONLY. This is where the F2 scheduled-plan-change
  // finaliser runs (it CANNOT run in-tx — self-deadlocks against the member-row
  // lock). Without coverage a regression dropping the invocation (or moving it
  // in-tx) would redden nothing.
  it('post-commit — onAfterCommitCallbacks fired with the invoice id on processed', async () => {
    const deps = makeDeps();
    const afterCommit = vi.fn(async () => undefined);
    const result = await confirmPayment(
      { ...deps, onAfterCommitCallbacks: [afterCommit] },
      INPUT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledWith(PENDING_PAYMENT.invoiceId);
  });

  it('post-commit — an onAfterCommitCallbacks throw is swallowed; the payment stays processed (never downgraded)', async () => {
    const deps = makeDeps();
    const afterCommit = vi.fn(async () => {
      throw new Error('F2 finalise blew up post-commit');
    });
    const result = await confirmPayment(
      { ...deps, onAfterCommitCallbacks: [afterCommit] },
      INPUT,
    );
    // The payment already committed — a finalise throw must NOT downgrade it.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
    expect(afterCommit).toHaveBeenCalledTimes(1);
  });

  it('post-commit — a NON-Error finalise throw is swallowed too (String(e) arm)', async () => {
    // The forensic log's `instanceof Error ? message : String(e)` right arm:
    // a promise-rejected string (or any non-Error) must not crash the swallow.
    const deps = makeDeps();
    const afterCommit = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw 'finalise string boom';
    });
    const result = await confirmPayment(
      { ...deps, onAfterCommitCallbacks: [afterCommit] },
      INPUT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('processed');
  });

  // Task 4 (review I-1) — the CAS-mismatch guard on the succeeded flip. When
  // `updateStatus` returns null (its `expectedCurrentStatus` no longer matched),
  // it must ROLL BACK, not continue: the UPDATE matched zero rows, so continuing
  // would let F4's `markPaidFromProcessor` flip the invoice to `paid` against a
  // payment row that was never advanced — a silent inconsistent commit, the
  // exact class this branch exists to prevent. The mismatch is unreachable under
  // the row lock in normal operation, which is precisely why it was untested;
  // that also means a refactor deleting the guard (or flipping rollbackTx →
  // commitTxWithRefusal) would redden nothing without this test.
  it('Task 4 I-1 — updateStatus CAS mismatch (null) rolls back; F4 markPaid NOT called', async () => {
    const deps = makeDeps();
    (deps.paymentsRepo.updateStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await confirmPayment(deps, INPUT);

    // Surfaces a transient decline so the webhook is retried, not 200-acked into
    // silence (a captured payment on a still-`pending` row).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('processor_unavailable');
      if (result.error.code === 'processor_unavailable') {
        expect(result.error.reason).toBe('payment_row_cas_mismatch');
      }
    }
    // THE money assertion: the invoice was NOT flipped to paid.
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    // And no payment_succeeded audit was emitted for a flip that did not happen.
    const succeededEmit = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1].eventType === 'payment_succeeded',
    );
    expect(succeededEmit).toBeUndefined();
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
    // Task 5 — the `.detail` is the PRODUCER half of the webhook-permanence
    // contract: `classifyDispatchPermanence` special-cases exactly this string
    // to `permanent`. Asserting only `.code` let a rename of the detail silently
    // reclassify an unconfigured-tenant capture as transient (→ 48h retries).
    if (result.error.code === 'bridge_error') {
      expect(result.error.detail).toBe('tenant_settings_missing');
    }
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

  // Round-2 review (MED — #1 status discrimination): createRefund returns ok
  // but the Refund settled `failed` SYNCHRONOUSLY at creation (money NOT
  // returned). Pre-fix the stale path flipped to auto_refunded + emitted ONLY
  // the "money returned" init trail, with no reliable follow-up webhook to
  // correct it. Fix: ALSO emit the `auto_refund_failed_needs_manual_reconcile`
  // forensic (drives the admin reconcile alert) — same event the webhook path
  // emits when the failure arrives async.
  it('Round-2 (MED) — stale auto-refund createRefund ok+status=failed → also emits auto_refund_failed_needs_manual_reconcile', async () => {
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
    (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      ok({ id: 're_test_auto', status: 'failed', amountSatang: asSatang(5_350_000n) }),
    );
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    // BOTH the init money-trail AND the money-not-returned forensic land.
    expect(
      auditCalls.some((c) => c[1].eventType === 'payment_auto_refunded_stale_invoice'),
    ).toBe(true);
    const failureAudit = auditCalls.find(
      (c) => c[1].eventType === 'auto_refund_failed_needs_manual_reconcile',
    );
    expect(failureAudit).toBeDefined();
    expect(failureAudit?.[1].payload.refund_status).toBe('failed');
    expect(failureAudit?.[1].payload.auto_refund_processor_refund_id).toBe('re_test_auto');
    expect(failureAudit?.[1].retentionYears).toBe(10);
  });

  // A.13 — guard-miss sub-case (i): a concurrent writer terminalised the row
  // (Phase A saw `pending`) to a DIFFERENT status between Phase A and the
  // Phase B flip. markAutoRefunded returns null; the use-case STILL emits the
  // money-trail audit + markProcessed (Stripe DID refund) AND now stamps the
  // status-agnostic recognition marker (runbook §1.1 sub-case (i), CLOSED) so
  // the auto-refund's later webhook is recognised instead of firing a false
  // OOB. Returns the stale outcome.
  it('A.13 — markAutoRefunded guard miss (sub-case i) stamps the status-agnostic marker + still audits + acks', async () => {
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
    // markAutoRefunded's `status='pending'` guard missed (row raced off
    // `pending`). The Phase-A-locked payment.status stays `pending` (the
    // default PENDING_PAYMENT) → the else branch (sub-case i) runs.
    (deps.paymentsRepo.markAutoRefunded as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    // The concurrent writer flipped the row to `succeeded`; the status-agnostic
    // marker-attach still lands (marker was absent).
    (deps.paymentsRepo.attachAutoRefundMarkerIfAbsent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...PENDING_PAYMENT,
      status: 'succeeded' as const,
      completedAt: new Date('2026-05-12T07:00:00.000Z'),
      autoRefundProcessorRefundId: 're_test_auto',
    });
    const result = await confirmPayment(deps, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    // THE FIX: the else branch now stamps the status-agnostic marker so a later
    // charge.refund.updated / charge.refunded recognises the auto-refund on the
    // concurrently-succeeded row instead of raising a false OOB (guard-miss i).
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paymentId: PENDING_PAYMENT.id,
        tenantId: TENANT_ID,
        processorRefundId: 're_test_auto',
      }),
    );

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
  // the A.15 status-agnostic marker so A.11 recognises the refund instead of
  // firing a false OOB. Sibling to sub-case (i) above (pending row raced to a
  // different terminal status → SAME status-agnostic marker, symmetric fix).
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
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledWith(
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

  // Marker-already-present races (Stripe retry idempotency): the attach helper
  // returns null and the ops warn — with a wired logger — must name the exact
  // guard-miss site so the runbook can confirm the refund. One per sub-case.
  it('guard-miss (ii) + marker already present → warns auto_refund_marker_on_failed_guard_miss', async () => {
    const warn = vi.fn();
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
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
    (deps.paymentsRepo.attachAutoRefundMarkerIfAbsent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await confirmPayment({ ...deps, logger: { warn } }, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(warn).toHaveBeenCalledWith(
      'confirm_payment.auto_refund_marker_on_failed_guard_miss',
      expect.objectContaining({ paymentId: FAILED_PAYMENT.id, processorRefundId: 're_test_auto' }),
    );
  });

  it('guard-miss (i) + marker already present → warns auto_refund_flip_guard_miss', async () => {
    const warn = vi.fn();
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
    (deps.paymentsRepo.attachAutoRefundMarkerIfAbsent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await confirmPayment({ ...deps, logger: { warn } }, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(warn).toHaveBeenCalledWith(
      'confirm_payment.auto_refund_flip_guard_miss',
      expect.objectContaining({ paymentId: PENDING_PAYMENT.id, processorRefundId: 're_test_auto' }),
    );
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
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledTimes(1);
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledWith(
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
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).not.toHaveBeenCalled();
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
    expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).not.toHaveBeenCalled();
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
    // PCI-clean: forensic uses the ch_ charge id (retrieved.value.latestChargeId
    // from the earlier retrievePaymentIntent call, 'ch_test_123' per the mock),
    // never card metadata. NOTE: distinct from the sibling A.13 stale-invoice
    // give-up path, which uses payment.processorPaymentIntentId (a pi_ id) —
    // don't conflate the two "give up" branches when reading this test.
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
        deps.paymentsRepo.attachAutoRefundMarkerIfAbsent,
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
  // ─── money-remediation Task 4 (F-1) — the settlement-abort flag ──────────
  //
  // These two pin WHY the rest of this file could stay green through a change
  // to commit semantics, and stop that from being mistaken for coverage.
  //
  // Every `paymentsRepo` double in this file stubs `withTx` as
  // `vi.fn(async (fn) => fn({}))` — a function that runs the callback and
  // neither commits nor rolls back. It cannot observe finding F-1 and it
  // cannot observe the fix. The real assertion lives in
  // `tests/integration/payments/confirm-payment-bridge-rollback.integration.test.ts`
  // against live Neon.
  describe('settlement abort on a bridge decline', () => {
    it('flag OFF — a bridge decline still returns bridge_error (behaviour preserved)', async () => {
      const deps = makeDeps();
      (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(err({ code: 'pdf_render_failed', reason: 'boom' }));

      const result = await confirmPayment(deps, INPUT);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('bridge_error');
      // No forensic row: the flag-off arm commits, so there is no rollback to
      // describe and nothing would outlive it.
      const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
      expect(
        auditCalls.some((c) => c[1].eventType === 'payment_settlement_rolled_back'),
      ).toBe(false);
    });

    it('flag ON — the payment-row write is ATTEMPTED and then DISCARDED', async () => {
      // Uses Task 2's rollback-capable double (`tests/support/fake-tx.ts`).
      // The suite's own `withTx: vi.fn(async (fn) => fn({}))` CANNOT express
      // this: it has no notion of a write, so it cannot discard one, and every
      // transactional assertion made against it passes whether or not anything
      // rolls back. That double is why finding F-1 sat green under this file.
      //
      // Note what it does NOT do: it does not trip `runTxDecided`'s
      // "runner does not roll back on throw" guard. That guard fires only for
      // a double that SWALLOWS the rollback throw and resolves anyway; every
      // double in this repo re-throws, so the signal propagates and
      // `runTxDecided` reports `committed: false` — a rollback it never
      // actually performed. Unit-level green here is therefore necessary but
      // never sufficient; the load-bearing proof is the live-Neon test at
      // tests/integration/payments/confirm-payment-bridge-rollback.integration.test.ts.
      const runner = makeFakeTxRunner();
      const deps = { ...makeDeps(), settlementAbort: true };
      (deps.paymentsRepo as { withTx: unknown }).withTx = runner.withTx.bind(runner);
      (deps.paymentsRepo.updateStatus as ReturnType<typeof vi.fn>).mockImplementation(
        async (tx: unknown) => {
          recordWrite(tx, 'payments.updateStatus', { nextStatus: 'succeeded' });
          return PENDING_PAYMENT;
        },
      );
      (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(err({ code: 'pdf_render_failed', reason: 'boom' }));

      const result = await confirmPayment(deps, INPUT);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('bridge_error');
      // Both halves: the write really was attempted (proving the fake was
      // wired through) AND it did not survive.
      expectRolledBack(runner, 'payments.updateStatus');

      // The forensic emit runs BEFORE the rollback decision and on a `null`
      // tx, so it is the one thing that outlives the transaction.
      const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
      const forensic = auditCalls.find(
        (c) => c[1].eventType === 'payment_settlement_rolled_back',
      );
      expect(forensic, 'forensic must be emitted before the decision').toBeDefined();
      expect(forensic?.[0], 'forensic MUST use a null tx so it survives').toBeNull();
      expect(forensic?.[1].payload.money_captured).toBe(true);
      expect(forensic?.[1].payload.bridge_error_code).toBe('pdf_render_failed');
      expect(forensic?.[1].retentionYears).toBe(10);
    });

    it('flag ON — a FAILED forensic emit is swallowed; the decline still returns bridge_error and rolls back (task-4 S-2)', async () => {
      // The forensic `emitSettlementRollbackForensic` wraps its `audit.emit` in
      // `.catch(() => {})`. That swallow is load-bearing: letting it throw would
      // escape `runTxDecided` as a raw 500 AND lose the rollback (the whole point
      // of the F-1 fix). Nothing tested it — removing the `.catch()` reddened
      // nothing — so this pins it: an audit-table outage during the forensic
      // must not turn a clean decline-and-rollback into a thrown 500.
      const runner = makeFakeTxRunner();
      const deps = { ...makeDeps(), settlementAbort: true };
      (deps.paymentsRepo as { withTx: unknown }).withTx = runner.withTx.bind(runner);
      (deps.paymentsRepo.updateStatus as ReturnType<typeof vi.fn>).mockImplementation(
        async (tx: unknown) => {
          recordWrite(tx, 'payments.updateStatus', { nextStatus: 'succeeded' });
          return PENDING_PAYMENT;
        },
      );
      (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(err({ code: 'pdf_render_failed', reason: 'boom' }));
      // The forensic emit (null tx, `payment_settlement_rolled_back`) REJECTS.
      (deps.audit.emit as ReturnType<typeof vi.fn>).mockImplementation(
        async (_tx: unknown, event: { eventType: string }) => {
          if (event.eventType === 'payment_settlement_rolled_back') {
            throw new Error('audit table unavailable');
          }
          return undefined;
        },
      );

      // MUST NOT throw — resolves the same decline as the happy-forensic case.
      const result = await confirmPayment(deps, INPUT);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('bridge_error');
      // The rollback still held despite the failed forensic.
      expectRolledBack(runner, 'payments.updateStatus');
      // And the invoice was never flipped to paid.
      expect(deps.invoicingBridge.markPaidFromProcessor).toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * I4 (money-remediation Task 7) — a failed payability READ must never be
 * mistaken for an unpayable invoice.
 *
 * `getInvoiceForPayment` newly accepts `externalTx`, which arms the invoice
 * repo's runtime tenant-mismatch guard — a raw `throw new Error`. Running on
 * the caller's connection also means an already-aborted tx throws here. So the
 * bridge now returns a typed `read_failed` where it previously let the throw
 * escape.
 *
 * Adding that union member WITHOUT an explicit branch here is a customer-money
 * bug, and a silent one. The Step-2 handling is an if-CHAIN, not a switch, and
 * it deliberately falls through for `not_payable`. An unhandled code therefore
 * reaches the `invoiceStatus` resolver, whose final arm is `: undefined` →
 * `inPayableStatus` false → `causeForInvoiceStatus(undefined)` hits its
 * `default:` arm → the stale-invoice branch AUTO-REFUNDS a customer who
 * legitimately paid, because a database read hiccuped. TypeScript flags none
 * of it: the ternary's `: undefined` arm and the `default:` arm both absorb a
 * new code silently.
 */
describe('confirmPayment — I4: bridge read_failed must not auto-refund', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns invoice_read_failed and refunds NOTHING when the payability read throws', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'read_failed' }),
    );

    const result = await confirmPayment(deps, INPUT);

    // THE ASSERTION THAT MATTERS. A read hiccup must not move the customer's
    // money. Everything else in this test is secondary to this line.
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();

    // Transient err, not ok(...): the dispatcher must classify this as
    // retryable so the route 500s and Stripe keeps retrying until the read
    // recovers. Returning ok/markProcessed would DROP a real payment
    // confirmation permanently — strictly worse than a retry storm.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_read_failed');

    // A DISTINCT code, not `bridge_error`. `bridge_error` sits in
    // PERMANENT_SUB_USE_CASE_DETAILS, so reusing it would 200 the webhook and
    // stop Stripe retrying — leaving the invoice `issued` forever with the
    // customer's money captured.
    expect(result.error.code).not.toBe('bridge_error');

    // The invoice was never flipped, and no auto-refund audit was written.
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(
      auditCalls.some((c) =>
        String(c[1]?.eventType ?? '').startsWith('payment_auto_refunded'),
      ),
    ).toBe(false);
  });

  // I4 sibling — same read_failed arrange, but WITH deps.logger wired so the
  // decision warn fires. The log line records the DECISION (transient err,
  // Stripe will retry) with bounded discriminators only — no raw error text.
  it('read_failed with deps.logger wired → the decision warn fires with bounded discriminators', async () => {
    const warn = vi.fn();
    const deps = { ...makeDeps(), logger: { warn } };
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'read_failed' }),
    );

    const result = await confirmPayment(deps, INPUT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invoice_read_failed');
    expect(warn).toHaveBeenCalledWith(
      'confirm_payment.invoice_read_failed',
      expect.objectContaining({
        bridgeOutcome: 'read_failed',
        disposition: 'transient_err_stripe_will_retry',
        paymentId: PENDING_PAYMENT.id,
      }),
    );
    // Still the assertion that matters: a read hiccup moves no money.
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
  });
});

/**
 * money-coverage remediation — the Step-2 bridge-error arms that ack the
 * webhook with a TX-BOUND forensic + markProcessed instead of auto-refunding.
 * Stripe has already CHARGED the customer on every one of these paths; the
 * broken side is OUR data, so the row must persist and the retry loop must
 * break — but `createRefund` must never fire.
 */
describe('confirmPayment — Step-2 bridge-error acks (forbidden / corrupted_total / new-flow-bill)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('bridge forbidden → invoice_not_found outcome, TX-BOUND forensic, markProcessed, no auto-refund', async () => {
    // F5R3 CR-4 — F4 `forbidden` is PERMANENT webhook-side: the forensic is
    // tx-bound (NOT null) so it commits atomically with markProcessed; a
    // rollback of one loses both, and Stripe retries cleanly.
    const markProcessed = vi.fn(async () => undefined);
    const deps = {
      ...makeDeps(),
      processorEventsRepo: {
        markProcessed,
      } as unknown as NonNullable<ConfirmPaymentDeps['processorEventsRepo']>,
    };
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'forbidden' }),
    );

    const result = await confirmPayment(deps, { ...INPUT, processorEventId: 'evt_forbidden' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('invoice_not_found');
    if (result.value.kind !== 'invoice_not_found') return;
    expect(result.value.invoiceId).toBe(PENDING_PAYMENT.invoiceId);
    expect(markProcessed).toHaveBeenCalledTimes(1);

    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const forensic = auditCalls.find(
      (c) => c[1].eventType === 'payment_invoice_not_found',
    );
    expect(forensic).toBeDefined();
    // TX-BOUND — first arg is the tx, NOT null (the not_found sibling is
    // also tx-bound; the null-tx pattern is reserved for rollback-surviving
    // forensics elsewhere in this file).
    expect(forensic?.[0]).not.toBeNull();
    // The SUMMARY is what discriminates `forbidden` from the not_found
    // sibling — this arm's payload carries no bridge_outcome field
    // (verified against source; only corrupted_total stamps one).
    expect(forensic?.[1].summary).toContain('forbidden');

    // Never auto-refund on a forbidden read (F5R1-E3), never settle.
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  it('bridge corrupted_total → invoice_data_corrupt + tx-bound forensic + markProcessed, no auto-refund', async () => {
    const markProcessed = vi.fn(async () => undefined);
    const deps = {
      ...makeDeps(),
      processorEventsRepo: {
        markProcessed,
      } as unknown as NonNullable<ConfirmPaymentDeps['processorEventsRepo']>,
    };
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'corrupted_total', invoiceId: 'inv_corrupt' }),
    );

    const result = await confirmPayment(deps, { ...INPUT, processorEventId: 'evt_corrupt' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('invoice_data_corrupt');
    if (result.value.kind !== 'invoice_data_corrupt') return;
    // Pins ACTUAL behaviour, verified against source: this arm echoes the
    // PAYMENT ROW's invoiceId (`payment.invoiceId`), NOT the bridge error's
    // own `invoiceId` field ('inv_corrupt'). The webhook side already holds
    // the locked row, so the row is authoritative here — unlike the
    // initiate path, which has no row yet and echoes `e.invoiceId`.
    expect(result.value.invoiceId).toBe(PENDING_PAYMENT.invoiceId);
    expect(markProcessed).toHaveBeenCalledTimes(1);

    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const forensic = auditCalls.find(
      (c) => c[1].eventType === 'payment_invoice_not_found',
    );
    expect(forensic).toBeDefined();
    expect(forensic?.[0]).not.toBeNull();
    expect(forensic?.[1].payload.bridge_outcome).toBe('corrupted_total');

    // Pre-fix the bridge silently capped totalSatang at 0n and fell through
    // to the stale branch — an auto-refund against a fake-zero baseline.
    expect(deps.processorGateway.createRefund).not.toHaveBeenCalled();
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });

  // 088 SEC-MED — `new_flow_bill_requires_flag_on` deliberately resolves to
  // `undefined` in `invoiceStatusFromBridgeError`, i.e. it DOES reach the
  // stale-invoice auto-refund with cause `invoice_unknown_status`.
  //
  // CAVEAT (carried verbatim from the source): that is PRE-EXISTING
  // behaviour deliberately preserved byte-for-byte by the I4 hardening
  // rather than changed as a side effect — "If it was never intended, that
  // is a separate finding for whoever owns 088 — do not 'fix' it inside an
  // unrelated change." This test pins CURRENT behaviour; it is not an
  // endorsement of auto-refunding on a flag rollback.
  //
  // Reachability note (financial review S-2): the real webhook rail passes
  // `reconciliationPath: true` to the bridge, which suppresses this error
  // today — the arm pinned here is the defensive switch arm, driven via the
  // mock. It becomes live only if a future caller omits that flag.
  it('bridge new_flow_bill_requires_flag_on → stale auto-refund with cause invoice_unknown_status (pins pre-existing behaviour)', async () => {
    const deps = makeDeps();
    (deps.invoicingBridge.getInvoiceForPayment as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'new_flow_bill_requires_flag_on' }),
    );

    const result = await confirmPayment(deps, INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');

    expect(deps.processorGateway.createRefund).toHaveBeenCalledTimes(1);
    expect(deps.processorGateway.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `auto-refund-${PENDING_PAYMENT.id}`,
      }),
    );

    // cause=invoice_unknown_status routes to the GENERIC stale event type,
    // not the concurrent-manual-mark variant (that is invoice_already_paid
    // only, per R3 CRIT-A).
    const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
    const staleAudit = auditCalls.find(
      (c) => c[1].eventType === 'payment_auto_refunded_stale_invoice',
    );
    expect(staleAudit).toBeDefined();
    expect(staleAudit?.[1].payload.cause).toBe('invoice_unknown_status');
    expect(
      auditCalls.some(
        (c) => c[1].eventType === 'payment_auto_refunded_concurrent_manual_mark',
      ),
    ).toBe(false);
    expect(deps.invoicingBridge.markPaidFromProcessor).not.toHaveBeenCalled();
  });
});

/**
 * `causeForInvoiceStatus` — pure Domain-adjacent mapping, exercised directly
 * so every arm (incl. the default bucket) is pinned without driving the whole
 * use-case through each invoice status.
 */
describe('causeForInvoiceStatus (pure helper)', () => {
  it.each([
    ['paid', 'invoice_already_paid'],
    ['void', 'invoice_voided'],
    ['credited', 'invoice_credited'],
    ['partially_credited', 'invoice_credited'],
    ['draft', 'invoice_unknown_status'],
    [undefined, 'invoice_unknown_status'],
    ['some_future_f4_status', 'invoice_unknown_status'],
  ] as ReadonlyArray<[string | undefined, string]>)(
    'maps %j → %s',
    (invoiceStatus, expectedCause) => {
      expect(causeForInvoiceStatus(invoiceStatus)).toBe(expectedCause);
    },
  );

  it('tripwire: paid and void map to DIFFERENT causes (audit labels must never conflate them)', () => {
    // `invoice_already_paid` routes to the dedicated concurrent-manual-mark
    // audit event; `invoice_voided` stays on the generic stale event.
    // Collapsing them would silently reroute the R3 CRIT-A spec edge case.
    expect(causeForInvoiceStatus('paid')).not.toBe(causeForInvoiceStatus('void'));
  });
});

/**
 * Give-up path residuals — the `input.processorEventId` presence arms and
 * the Phase-B markProcessed failure containment (F5R2-SF-3).
 */
describe('confirmPayment — stale give-up with processorEventId + Phase-B failure containment', () => {
  beforeEach(() => vi.clearAllMocks());

  function arrangeStaleGiveUp(deps: ConfirmPaymentDeps): void {
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
    // 49h after the event → past the 48h give-up ceiling (R1-E9 idiom).
    const eventTs = INPUT.eventCreatedAtUnixSeconds;
    deps.clock.nowMs = () => (eventTs + 49 * 60 * 60) * 1000;
  }

  it('stale give-up WITH processorEventId → forensic carries evt_giveup_1, not the event-${paymentId} fallback', async () => {
    const deps = makeDeps();
    arrangeStaleGiveUp(deps);

    const result = await confirmPayment(deps, { ...INPUT, processorEventId: 'evt_giveup_1' });

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
    // No refund was actually created (the Stripe call failed), so the
    // Stripe EVENT id is the forensic correlation key — NOT the
    // `event-${payment.id}` fallback reserved for eventId-less callers.
    expect(giveUp?.[1].payload.processor_refund_id).toBe('evt_giveup_1');
    expect(giveUp?.[1].summary).toContain('evt_giveup_1');
  });

  it('stale give-up + Phase-B markProcessed tx throws → metric + warn (errKind per throw shape), still acks', async () => {
    // F5R2-SF-3 — the stuck-row class: the give-up audit commits (null tx)
    // and Stripe gets its 200, but the Phase-B tx that stamps processed_at
    // dies. The counter + warn are the ONLY signals; the ack must survive.
    const metricSpy = vi
      .spyOn(paymentsMetrics, 'confirmPaymentGiveUpPhaseBMarkProcessedFailed')
      .mockImplementation(() => {});
    try {
      for (const [thrown, expectedErrKind] of [
        [new Error('phase-b tx down'), 'Error'],
        ['raw string rejection', 'unknown'],
      ] as ReadonlyArray<[unknown, string]>) {
        vi.clearAllMocks();
        const warn = vi.fn();
        const deps = { ...makeDeps(), logger: { warn } };
        arrangeStaleGiveUp(deps);
        // Phase A passes through; the SECOND withTx (the give-up's Phase-B
        // markProcessed) rejects — mirrors rejectSecondTx in the webhook suite.
        const tx = deps.paymentsRepo.withTx as ReturnType<typeof vi.fn>;
        tx.mockReset();
        tx.mockImplementationOnce(async <T,>(fn: (t: unknown) => Promise<T>) => fn({}));
        tx.mockImplementationOnce(async () => {
          throw thrown;
        });

        const result = await confirmPayment(deps, INPUT);

        // The ack survives the Phase-B failure — Stripe must still drain.
        expect(result.ok, `errKind=${expectedErrKind}`).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind, `errKind=${expectedErrKind}`).toBe('auto_refund_given_up');
        expect(metricSpy, `errKind=${expectedErrKind}`).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'confirm_payment.give_up_phase_b_mark_processed_failed',
          expect.objectContaining({
            paymentId: PENDING_PAYMENT.id,
            errKind: expectedErrKind,
          }),
        );
      }
    } finally {
      metricSpy.mockRestore();
    }
  });
});

/**
 * Late-charge (#8) — synchronous refund failure at creation + the F8
 * post-commit gate on non-processed outcomes.
 */
describe('confirmPayment — late-charge sync-failed refund + F8 post-commit gating', () => {
  beforeEach(() => vi.clearAllMocks());

  // Round-2 (MED — #1 status discrimination), late-charge flavour: Stripe
  // ACCEPTED the refund but it settled failed/canceled SYNCHRONOUSLY — the
  // money was NOT returned and no reliable follow-up webhook exists. The
  // money-not-returned forensic + page metric must fire NOW.
  it.each(['failed', 'canceled'] as const)(
    'late-charge refund settles %s at creation → Late-charge forensic + reconcile metric, marker still stamped',
    async (refundStatus) => {
      const reconcileSpy = vi
        .spyOn(paymentsMetrics, 'autoRefundFailedNeedsReconcile')
        .mockImplementation(() => {});
      try {
        const deps = makeDeps();
        (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          FAILED_PAYMENT,
        );
        (deps.processorGateway.createRefund as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          ok({ id: 're_test_auto', status: refundStatus, amountSatang: asSatang(5_350_000n) }),
        );

        const result = await confirmPayment(deps, INPUT);

        expect(result.ok, `refundStatus=${refundStatus}`).toBe(true);
        if (!result.ok) return;
        expect(result.value.kind).toBe('auto_refunded_stale_invoice');

        const auditCalls = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls;
        const failureAudit = auditCalls.find(
          (c) => c[1].eventType === 'auto_refund_failed_needs_manual_reconcile',
        );
        expect(failureAudit, `refundStatus=${refundStatus}`).toBeDefined();
        expect(failureAudit?.[1].payload.refund_status).toBe(refundStatus);
        expect(failureAudit?.[1].retentionYears).toBe(10);
        // The 'Late-charge' summary pin is load-bearing: the STALE twin
        // emits the SAME event type with summary 'Auto-refund for payment…'
        // — without this pin the stale sibling would satisfy the test.
        expect(failureAudit?.[1].summary).toContain('Late-charge');

        // Page metric fired; the durable marker still landed (F-9: the row
        // stays failed, the marker is what suppresses the false OOB later).
        expect(reconcileSpy).toHaveBeenCalledTimes(1);
        expect(deps.paymentsRepo.attachAutoRefundMarkerIfAbsent).toHaveBeenCalledTimes(1);
      } finally {
        reconcileSpy.mockRestore();
      }
    },
  );

  it('late-charge marker already present (Stripe retry) → warns late_charge_marker_guard_miss, still acks', async () => {
    const warn = vi.fn();
    const deps = makeDeps();
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      FAILED_PAYMENT,
    );
    (deps.paymentsRepo.attachAutoRefundMarkerIfAbsent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const result = await confirmPayment({ ...deps, logger: { warn } }, INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('auto_refunded_stale_invoice');
    expect(warn).toHaveBeenCalledWith(
      'confirm_payment.late_charge_marker_guard_miss',
      expect.objectContaining({ paymentId: FAILED_PAYMENT.id, processorRefundId: 're_test_auto' }),
    );
  });

  // The F8 post-commit gate: `processed` is the ONE outcome that means the
  // invoice flipped issued → paid in THIS dispatch. Firing the finaliser on
  // any other outcome would emit a false `plan_change_applied`.
  it('post-commit F8 hooks NOT fired on a non-processed outcome (already_succeeded)', async () => {
    const deps = makeDeps();
    const afterCommit = vi.fn(async () => undefined);
    (deps.paymentsRepo.lockForUpdateByPaymentIntentId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      { ...PENDING_PAYMENT, status: 'refunded' as const },
    );

    const result = await confirmPayment(
      { ...deps, onAfterCommitCallbacks: [afterCommit] },
      INPUT,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('already_succeeded');
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it('post-commit F8 hooks NOT fired when the bridge declines (result not ok)', async () => {
    const deps = makeDeps();
    const afterCommit = vi.fn(async () => undefined);
    (deps.invoicingBridge.markPaidFromProcessor as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'pdf_render_failed', detail: 'x' }),
    );

    const result = await confirmPayment(
      { ...deps, onAfterCommitCallbacks: [afterCommit] },
      INPUT,
    );

    expect(result.ok).toBe(false);
    expect(afterCommit).not.toHaveBeenCalled();
  });
});
