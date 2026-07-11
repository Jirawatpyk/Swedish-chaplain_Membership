/**
 * PR-A Task A.9 (#1) — shared `finalizeSucceededRefund` helper.
 *
 * Extracted from `issueRefund`'s Phase B so the SAME finalisation logic
 * is reused by:
 *   - `issueRefund` (admin-initiated, `path: 'admin_initiated'`) — the
 *     Stripe `createRefund` returned `succeeded` synchronously.
 *   - `processRefundUpdated` (A.11, `path: 'webhook_refund_updated'`) —
 *     an async `charge.refund.updated(succeeded)` finalises a refund
 *     row that was left `pending` at creation time.
 *   - the Stripe-aware sweep (A.14) — a `retrieveRefund` that reports
 *     `succeeded` reconciles a stuck-pending row.
 *
 * Sharing one finaliser removes the drift risk that let bug #1 through
 * (the old inline Phase B flip at `issue-refund.ts:474` omitted
 * `expectedCurrentStatus`, so a concurrent webhook could double-book).
 *
 * What it does, in order, INSIDE the caller's passed `tx`:
 *   1. Issue the F4 credit note via the bridge. F4 owns its OWN tx
 *      (PDF render + Blob upload + §87 sequence + audit + outbox); the
 *      call is idempotent per `(tenant_id, source_refund_id)` (A.7), so
 *      a repeat returns the EXISTING CN with no new §87 number / PDF.
 *   2. Flip the refund row `pending → succeeded` with
 *      `expectedCurrentStatus='pending'`. A `null` return (A.5) means a
 *      sibling writer (a racing `charge.refund.updated` webhook) already
 *      finalised it → treat as a benign, coherent "already finalised"
 *      no-op: the CN already exists (step 1 returned it), the payment is
 *      already flipped, so we return the finalized state WITHOUT a
 *      second payment flip or a duplicate `refund_succeeded` audit.
 *   3. Flip the payment row to `paymentNextStatus`.
 *   4. Emit `refund_succeeded` with the caller-supplied `path`.
 *
 * DUAL-MODE payment flip (A.11 built): the caller discriminates via the
 * OPTIONAL `paymentNextStatus`:
 *   - ADMIN mode (`issueRefund`) PROVIDES it (computed under its Phase A
 *     payment lock) → the simple flip runs, byte-identical to pre-A.11.
 *   - WEBHOOK mode (`processRefundUpdated`) OMITS it → the helper self-locks
 *     the payment `FOR UPDATE` FIRST, reads the refunds aggregate under that
 *     lock (SB-1 ordering), derives the next status, and flips with the
 *     `expectedCurrentStatus` race-guard + SB-1 parent-payment recovery
 *     (ported verbatim from `process-charge-refunded.ts`; RR-5 / H-c so
 *     A.12 deleting that block loses nothing). See the payment-flip section.
 * The refund row is locked by the WEBHOOK caller before this helper runs, so
 * the system-wide lock-acquisition order is refund-row → payment-row (A.11
 * report deadlock analysis).
 *
 * Invoice status (tax#5): a projection of `paymentNextStatus`
 * (`refunded → credited`, else `partially_credited`) — NOT a new F5
 * refund-sum arithmetic. Task B.2 replaces this with the
 * F4-authoritative `credited_total` read so A1/A2/A5 all report the
 * same value even when a manual F4 credit note already exists.
 *
 * Pure Application — no framework / ORM imports. Operates within the
 * caller's `tx`; the F4 CN bridge manages its own transaction.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Satang } from '@/lib/money';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  LoggerPort,
  PaymentsRepo,
  RefundsRepo,
} from '../ports';
import { asPaymentId } from '../../domain/payment';
import { retentionFor } from '../ports/audit-port';

/**
 * The triggers that flow through the shared finaliser. Matches the
 * `refund_succeeded` audit `path` discriminator (`audit-port.ts`):
 *   - `admin_initiated`       — `issueRefund` (Stripe returned succeeded
 *                               synchronously; ADMIN mode).
 *   - `webhook_refund_updated`— `processRefundUpdated` (async
 *                               `charge.refund.updated(succeeded)`; WEBHOOK mode).
 *   - `sweep_recovery`        — A.14 Stripe-aware stale-pending sweep
 *                               (`retrieveRefund` reported succeeded on a
 *                               stuck-`pending` row the webhook never
 *                               resolved; WEBHOOK mode).
 */
export type FinalizeSucceededRefundPath =
  | 'admin_initiated'
  | 'webhook_refund_updated'
  | 'sweep_recovery';

export interface FinalizeSucceededRefundInput {
  readonly refundId: string;
  readonly tenantId: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountSatang: Satang;
  /** Free-form reason — forwarded to the F4 CN (its `reason` column + PDF). */
  readonly reason: string;
  /** Stripe `re_…` id — re-affirmed on the refund row + carried in the audit. */
  readonly processorRefundId: string;
  /**
   * A.11 DUAL-MODE discriminator for the payment flip:
   *
   *   ADMIN mode (A.9 `issueRefund`) — PROVIDED. The caller computed this
   *   under its Phase A payment `FOR UPDATE` lock and passes it → the
   *   helper does the simple payment flip, byte-identical to the pre-A.11
   *   behaviour (no self-lock, no recovery).
   *
   *   WEBHOOK mode (A.11 `processRefundUpdated`) — OMITTED. The helper
   *   self-locks the payment `FOR UPDATE`, reads the refunds aggregate
   *   under that lock (SB-1 ordering — payment lock BEFORE the aggregate
   *   read), derives the next status itself, and flips with the
   *   `expectedCurrentStatus` race-guard + SB-1 parent-payment recovery
   *   (ported verbatim from `process-charge-refunded.ts`; RR-5 / H-c, so
   *   A.12 deleting that block does not lose the recovery). The refund-flip
   *   `expectedCurrentStatus='pending'` guard already serialises so only
   *   one writer reaches the payment flip per refund.
   */
  readonly paymentNextStatus?: 'partially_refunded' | 'refunded';
  readonly actorUserId: string;
  readonly requestId: string | null;
  readonly path: FinalizeSucceededRefundPath;
}

export interface FinalizeSucceededRefundResult {
  readonly creditNoteId: string;
  readonly creditNoteNumber: string;
  readonly paymentNextStatus: 'partially_refunded' | 'refunded';
  readonly invoiceStatus: 'partially_credited' | 'credited';
  /**
   * A.9 review fix (#1) — `true` when the refund-flip's
   * `expectedCurrentStatus='pending'` guard matched ZERO rows (a sibling
   * writer, e.g. A.11's `charge.refund.updated` webhook consumer, already
   * finalised this refund — the null-race branch above). `false` when THIS
   * call performed the genuine flip. Callers MUST gate any
   * finalize-once side effect (metric increments) on `siblingWon === false`
   * — the sibling that actually flipped the row already owns that side
   * effect. Internal helper-return detail only: NOT part of the public
   * `IssueRefundSuccess` envelope.
   */
  readonly siblingWon: boolean;
}

/**
 * The only failure surfaced by the finaliser: the F4 credit-note bridge
 * declined. Carries F4's `{ code, detail }` verbatim so the caller can
 * build the `f4_bridge_<code>` failure-reason code + surface `detail`.
 * A Phase B DB throw is NOT caught here — it propagates through the
 * caller's `withTx` so the caller's own try/catch runs the
 * out-of-band-refund recovery (C2).
 */
export interface FinalizeSucceededRefundError {
  readonly code: string;
  readonly detail: string;
}

export interface FinalizeSucceededRefundDeps {
  // A.11 — WEBHOOK mode self-reads the payment (`lockForUpdate`) + the
  // refunds aggregate (`getRefundContextForUpdate`) for the SB-1 port;
  // ADMIN mode never calls them (it pre-computes `paymentNextStatus`). The
  // wider `Pick` is satisfied by both callers' full repos.
  readonly paymentsRepo: Pick<PaymentsRepo, 'updateStatus' | 'lockForUpdate'>;
  readonly refundsRepo: Pick<RefundsRepo, 'updateStatus' | 'getRefundContextForUpdate'>;
  readonly invoicingBridge: Pick<InvoicingBridgePort, 'issueCreditNoteFromRefund'>;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * A.11 (SB-1 port) — optional structured logger for the WEBHOOK-mode
   * parent-payment-recovery race warn (a concurrent writer advanced the
   * parent before this call could). Optional so existing admin-path
   * scaffolding still compiles; the webhook composition threads the real
   * pino logger.
   */
  readonly logger?: LoggerPort;
}

export async function finalizeSucceededRefund(
  deps: FinalizeSucceededRefundDeps,
  tx: unknown,
  input: FinalizeSucceededRefundInput,
): Promise<Result<FinalizeSucceededRefundResult, FinalizeSucceededRefundError>> {
  // --- Step 1: F4 credit note (idempotent per (tenant, source_refund_id)) ---
  // F4 manages its own tx; the passed `tx` is idle for the duration of
  // this external call (PDF render + Blob upload). Acceptable: refunds
  // are low-frequency (admin 20/5min) and A.11 requires this call inside
  // the same `tx` window as `markProcessed` for atomicity.
  const cnResult = await deps.invoicingBridge.issueCreditNoteFromRefund({
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    refundId: input.refundId,
    amountSatang: input.amountSatang,
    reason: input.reason,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
  });
  if (!cnResult.ok) {
    return err({ code: cnResult.error.code, detail: cnResult.error.detail });
  }

  const completedAt = new Date(deps.clock.nowMs());

  // --- Step 2: REFUND-FLIP SECTION -----------------------------------------
  // A.11: the WEBHOOK caller has already locked this refund row FOR UPDATE
  // (`lockForUpdateByProcessorRefundId`); the ADMIN caller reaches it via
  // this UPDATE. The `expectedCurrentStatus='pending'` guard makes the flip
  // race-safe: a `null` return means a sibling finalised first.
  const updatedRefund = await deps.refundsRepo.updateStatus(tx, {
    refundId: input.refundId,
    tenantId: input.tenantId,
    nextStatus: 'succeeded',
    processorRefundId: input.processorRefundId,
    creditNoteId: cnResult.value.creditNoteId,
    completedAt,
    expectedCurrentStatus: 'pending',
  });

  if (updatedRefund === null) {
    // Sibling won the race (a concurrent `charge.refund.updated` webhook
    // already flipped refund→succeeded + payment + emitted the audit).
    // The idempotent CN read above returned that sibling's CN. Return the
    // coherent finalized state as a benign no-op — do NOT flip the
    // payment again or emit a duplicate `refund_succeeded` audit.
    //
    // `paymentNextStatus`/`invoiceStatus` below are consumed ONLY by the
    // ADMIN caller (which always provides `input.paymentNextStatus` and
    // reads `invoiceStatus` into its envelope). The WEBHOOK caller returns
    // `already_finalized` and ignores both, so the `?? 'refunded'` filler
    // is an unconsumed, type-only default on that path.
    const reportedNextStatus = input.paymentNextStatus ?? 'refunded';
    return ok({
      creditNoteId: cnResult.value.creditNoteId,
      creditNoteNumber: cnResult.value.creditNoteNumber,
      paymentNextStatus: reportedNextStatus,
      invoiceStatus:
        reportedNextStatus === 'refunded' ? 'credited' : 'partially_credited',
      siblingWon: true,
    });
  }

  // --- Step 3: PAYMENT-FLIP SECTION (dual-mode) ----------------------------
  const paymentId = asPaymentId(input.paymentId);
  let resolvedNextStatus: 'partially_refunded' | 'refunded';

  if (input.paymentNextStatus !== undefined) {
    // ADMIN mode — caller pre-computed the next status under its Phase A
    // payment lock. Byte-identical to the pre-A.11 flip (no self-lock, no
    // recovery); the refund-flip guard above already serialised us in.
    resolvedNextStatus = input.paymentNextStatus;
    await deps.paymentsRepo.updateStatus(tx, {
      paymentId,
      tenantId: input.tenantId,
      nextStatus: resolvedNextStatus,
      completedAt,
    });
  } else {
    // WEBHOOK mode (A.11 SB-1 port) — no caller pre-lock. Acquire the
    // payment-row FOR UPDATE lock BEFORE the refunds aggregate read so
    // `succeededSum` includes the just-flipped refund and a concurrent
    // refund cannot skew the derived status (the `expectedCurrentStatus`
    // guard below protects the row write, NOT a status derived from a stale
    // sum). Lock-ordering invariant: the refund row is already FOR-UPDATE
    // locked by the caller, so acquisition order across the system is
    // refund-row → payment-row (see A.11 report deadlock analysis).
    const parent = await deps.paymentsRepo.lockForUpdate(
      tx,
      paymentId,
      input.tenantId,
    );
    const ctx = await deps.refundsRepo.getRefundContextForUpdate(
      tx,
      input.tenantId,
      paymentId,
    );
    const isFullyRefunded =
      parent != null && ctx.succeededSumSatang >= parent.amountSatang;
    resolvedNextStatus = isFullyRefunded ? 'refunded' : 'partially_refunded';

    // SB-1 parent-payment recovery — only advance from a live succeeded /
    // partially_refunded parent, and only when the status actually changes.
    if (
      parent != null &&
      (parent.status === 'succeeded' ||
        parent.status === 'partially_refunded') &&
      parent.status !== resolvedNextStatus
    ) {
      const updatedPayment = await deps.paymentsRepo.updateStatus(tx, {
        paymentId,
        tenantId: input.tenantId,
        nextStatus: resolvedNextStatus,
        expectedCurrentStatus: parent.status,
        completedAt,
      });
      if (updatedPayment === null) {
        // expectedCurrentStatus race — a concurrent writer advanced the
        // parent before us; the refund-row flip already committed and the
        // parent status was set by someone else. Silent no-op (idempotent).
        deps.logger?.warn(
          'finalize_succeeded_refund.parent_status_recovery_race',
          {
            tenantId: input.tenantId,
            paymentId: input.paymentId,
            refundId: input.refundId,
            expectedStatus: parent.status,
            attemptedNextStatus: resolvedNextStatus,
          },
        );
      }
    }
  }

  // tax#5 (A.9): invoice status is a PROJECTION of the (resolved) payment
  // status, NOT a second refund-sum arithmetic. B.2 swaps this for the
  // F4-authoritative `credited_total` read.
  const invoiceStatus: 'partially_credited' | 'credited' =
    resolvedNextStatus === 'refunded' ? 'credited' : 'partially_credited';

  // --- Step 4: audit refund_succeeded (path-discriminated) -----------------
  await deps.audit.emit(tx, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'refund_succeeded',
    actorUserId: input.actorUserId,
    summary: `Refund ${input.refundId} succeeded — credit note ${cnResult.value.creditNoteNumber} issued for ${input.amountSatang.toString()} satang`,
    payload: {
      path: input.path,
      refund_id: input.refundId,
      payment_id: input.paymentId,
      invoice_id: input.invoiceId,
      processor_refund_id: input.processorRefundId,
      credit_note_id: cnResult.value.creditNoteId,
      credit_note_number: cnResult.value.creditNoteNumber,
      amount_satang: input.amountSatang.toString(),
      payment_next_status: resolvedNextStatus,
      invoice_next_status: invoiceStatus,
    },
    retentionYears: retentionFor('refund_succeeded'),
  });

  return ok({
    creditNoteId: cnResult.value.creditNoteId,
    creditNoteNumber: cnResult.value.creditNoteNumber,
    paymentNextStatus: resolvedNextStatus,
    invoiceStatus,
    siblingWon: false,
  });
}
