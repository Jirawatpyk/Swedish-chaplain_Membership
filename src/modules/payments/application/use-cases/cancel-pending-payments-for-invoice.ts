/**
 * cancelPendingPaymentsForInvoice — cancel every PaymentIntent still live at
 * Stripe for an invoice that is no longer payable. Called by F4 `voidInvoice`
 * (through its `PendingPaymentCancellerPort`) AFTER the void commits.
 *
 * Why (follow-up to the #446 financial-integrity review, M-a): a void never
 * touched `payments`. A card PaymentIntent a member had already opened stayed
 * live, the PaySheet keeps its `clientSecret` across drawer reopen, and a
 * later confirm went straight to Stripe — bypassing `initiatePayment`'s
 * non-issued guard — so Stripe captured money for a voided invoice and
 * confirm-payment's stale-invoice guard auto-refunded it days later. Stripe
 * card PaymentIntents do not expire on their own; nothing else closes this.
 *
 * Shape: per pending row, the same two phases as `cancelPayment` (whose
 * docblock carries the full rationale), minus the member role/ownership gate:
 *   Phase A — tx: lock the row, require `canTransition(→canceled)`.
 *   Stripe  — `cancelPaymentIntent` OUTSIDE any tx (no row lock held across
 *             the SDK call).
 *   Phase B — tx: re-lock; already `canceled` → idempotent (the
 *             payment_intent.canceled webhook beat us); illegal transition →
 *             forensic audit, never overwrite; else CAS `updateStatus` with
 *             `expectedCurrentStatus` + `payment_canceled` in the same tx.
 *
 * Both transactions run through `runTxDecided`: every exit is an explicit
 * commit. The only writes are the CAS status flip + its audit row, or a
 * forensic `payment_cancel_attempt_failed` row that must survive by design —
 * no branch writes money-side state and then refuses.
 *
 * Only payment rows are locked — never the invoice. confirm-payment locks
 * payment → invoice; taking payment locks while void holds the invoice lock
 * would invert that order, which is why the caller runs this post-commit.
 *
 * The pending-row read takes the SAME `payments:{tenant}:{invoice}` advisory
 * lock `initiatePayment` holds across its Stripe create + insert, so an
 * initiate that was mid-flight when the void committed finishes first and its
 * row is listed (and canceled) rather than slipping in after an empty read.
 * The residual window — an initiate that read the invoice as `issued` before
 * the void but takes the lock only after this read — closes only when
 * initiate re-checks the status under that lock (#446 adds the non-issued
 * guard; see the PR notes).
 *
 * Best-effort: Stripe refusals and lost races are recorded per row
 * (`payment_cancel_attempt_failed`) and never turned into an error result. A
 * DB fault (lock / read / write) does propagate — the caller (`voidInvoice`)
 * swallows it with a metric, and the void stands. A row left `pending` that
 * is later captured is still caught by the webhook's stale-invoice
 * auto-refund; `payment_intent_already_succeeded` is left entirely to it.
 */
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { commitTx, runTxDecided } from '../settlement/tx-decision';
import type { Payment } from '../../domain/payment';
import type {
  AuditPort,
  ClockPort,
  PaymentsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { retentionFor } from '../ports/audit-port';

export interface CancelPendingPaymentsForInvoiceInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** Who triggered it (the voiding user) — recorded as the audit actor. */
  readonly actorUserId: string;
  readonly cause: 'invoice_voided';
  readonly requestId: string | null;
}

export interface CancelPendingPaymentsForInvoiceResult {
  /** Rows now `canceled` (by us, or by a webhook that beat us). */
  readonly canceled: number;
  /** Rows deliberately left alone (no longer pending, or already captured). */
  readonly skipped: number;
  /** Rows that should have been canceled but are still `pending`/unresolved. */
  readonly failed: number;
}

export interface CancelPendingPaymentsForInvoiceDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

type RowOutcome = 'canceled' | 'skipped' | 'failed';

export async function cancelPendingPaymentsForInvoice(
  deps: CancelPendingPaymentsForInvoiceDeps,
  input: CancelPendingPaymentsForInvoiceInput,
): Promise<CancelPendingPaymentsForInvoiceResult> {
  // Read under initiate's advisory lock (see docblock). Read-only; released
  // at commit before any per-row lock or Stripe call.
  const { value: rows } = await runTxDecided<readonly Payment[]>(deps.paymentsRepo, async (tx) => {
    await deps.paymentsRepo.acquireInitiateLock(tx, input.tenantId, input.invoiceId);
    return commitTx(await deps.paymentsRepo.listPendingByInvoice(input.tenantId, input.invoiceId, tx));
  });
  const result = { canceled: 0, skipped: 0, failed: 0 };
  if (rows.length === 0) return result;

  // Outside any tx for the same reason as cancelPayment: the settings adapter
  // reads through its own cached connection and does not take a `tx`.
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);

  // Sequential on purpose: typically 0–1 rows, and one row's Stripe latency
  // must not hold a DB connection for another.
  for (const row of rows) {
    const outcome: RowOutcome =
      settings === null
        ? await recordAttemptFailed(deps, input, row, 'permanent', 'tenant payment settings missing')
        : await cancelOne(deps, input, row, settings.processorAccountId);
    result[outcome] += 1;
  }
  return result;
}

async function cancelOne(
  deps: CancelPendingPaymentsForInvoiceDeps,
  input: CancelPendingPaymentsForInvoiceInput,
  listed: Payment,
  processorAccountId: string,
): Promise<RowOutcome> {
  // ---------------- Phase A: lock + validate + release ----------------
  // Read-only (lock + release): nothing to roll back on any branch.
  const { value: current } = await runTxDecided<Payment | null>(deps.paymentsRepo, async (tx) =>
    commitTx(await deps.paymentsRepo.lockForUpdate(tx, listed.id, input.tenantId)),
  );
  // Gone, or moved on (succeeded / failed / canceled) since the list read —
  // nothing live to cancel from here.
  if (current === null || !canTransition(current.status, 'canceled').ok) return 'skipped';

  // ---------------- Stripe call OUTSIDE tx ----------------
  const cancelResult = await deps.processorGateway.cancelPaymentIntent(
    current.processorPaymentIntentId,
    processorAccountId,
  );
  if (!cancelResult.ok) {
    if (
      cancelResult.error.kind === 'permanent' &&
      cancelResult.error.code === 'payment_intent_already_succeeded'
    ) {
      // Captured before we got there. confirm-payment's stale-invoice branch
      // owns this row (auto-refund); touching it here would race that path.
      return 'skipped';
    }
    return recordAttemptFailed(
      deps,
      input,
      current,
      cancelResult.error.kind,
      `Stripe cancel failed (${cancelResult.error.kind})`,
    );
  }

  // ---------------- Phase B: re-lock + commit + audit ----------------
  const phaseB = await runTxDecided<{ readonly outcome: RowOutcome }>(deps.paymentsRepo, async (tx) => {
    const fresh = await deps.paymentsRepo.lockForUpdate(tx, current.id, input.tenantId);
    if (fresh === null) {
      // Phase A saw the row; Stripe has already canceled the intent. The row's
      // absence is the only signal ops will get — leave a forensic trail.
      await emitAttemptFailed(deps, tx, input, current, 'permanent',
        `Phase B lock miss after Stripe cancel for payment ${current.id} — reconcile against the Stripe Dashboard`);
      return commitTx({ outcome: 'failed' });
    }
    // payment_intent.canceled webhook landed first — its own audit row stands.
    if (fresh.status === 'canceled') return commitTx({ outcome: 'canceled' });

    if (!canTransition(fresh.status, 'canceled').ok) {
      // e.g. a succeeded webhook between phases: never overwrite fund movement.
      // The only write is the forensic row, which must survive — commit it.
      await emitAttemptFailed(deps, tx, input, fresh, 'permanent',
        `Phase B race: payment ${fresh.id} status=${fresh.status} after Stripe cancel returned ok — Stripe Dashboard reconciliation may be needed`);
      return commitTx({ outcome: 'failed' });
    }

    const updated = await deps.paymentsRepo.updateStatus(tx, {
      paymentId: fresh.id,
      tenantId: input.tenantId,
      nextStatus: 'canceled',
      expectedCurrentStatus: fresh.status,
      completedAt: new Date(deps.clock.nowMs()),
    });
    if (updated === null) {
      // CAS zero-match wrote nothing; keep the forensic row.
      await emitAttemptFailed(deps, tx, input, fresh, 'permanent',
        `Phase B narrow race: updateStatus zero-match for payment ${fresh.id}`);
      return commitTx({ outcome: 'failed' });
    }

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_canceled',
      actorUserId: input.actorUserId,
      summary: `Payment ${fresh.id} canceled because invoice ${fresh.invoiceId} was voided`,
      payload: {
        payment_id: fresh.id,
        invoice_id: fresh.invoiceId,
        actor_type: 'system',
        cause: input.cause,
      },
      retentionYears: retentionFor('payment_canceled'),
    });
    return commitTx({ outcome: 'canceled' });
  });
  return phaseB.value.outcome;
}

/** Best-effort forensic row on a `null` tx, so it survives regardless. */
async function recordAttemptFailed(
  deps: CancelPendingPaymentsForInvoiceDeps,
  input: CancelPendingPaymentsForInvoiceInput,
  row: Payment,
  kind: 'retryable' | 'permanent' | 'idempotency_conflict',
  why: string,
): Promise<RowOutcome> {
  await emitAttemptFailed(deps, null, input, row, kind,
    `Payment ${row.id} left pending after invoice ${row.invoiceId} was voided: ${why}`);
  return 'failed';
}

async function emitAttemptFailed(
  deps: CancelPendingPaymentsForInvoiceDeps,
  tx: unknown,
  input: CancelPendingPaymentsForInvoiceInput,
  row: Payment,
  kind: 'retryable' | 'permanent' | 'idempotency_conflict',
  summary: string,
): Promise<void> {
  await deps.audit.emit(tx, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'payment_cancel_attempt_failed',
    actorUserId: input.actorUserId,
    summary,
    payload: {
      payment_id: row.id,
      invoice_id: row.invoiceId,
      actor_type: 'system',
      cause: input.cause,
      processor_error_kind: kind,
    },
    retentionYears: retentionFor('payment_cancel_attempt_failed'),
  });
}
