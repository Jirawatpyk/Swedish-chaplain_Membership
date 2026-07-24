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
 * Invoice status (tax#5, B.2): sourced from F4 — the authoritative
 * tax-document system — via `invoicingBridge.getInvoiceStatus` AFTER the
 * credit note is issued, NOT a projection of the F5 payment status. F4 owns
 * the `credited`/`partially_credited` boundary (its `applyCreditNoteRollup`),
 * so all three callers (admin A.9 / webhook A.11 / sweep A.14) report the same
 * value even when a MANUAL F4 credit note already partially credited the
 * invoice (the case the old payment-based projection got wrong). If the F4
 * status read errors, we fall back to the payment-derived projection — a
 * refund that already succeeded (CN + Stripe both committed) is never failed
 * over a status READ hiccup; the DB invoice status stays F4-authoritative.
 *
 * Pure Application — no framework / ORM imports. Operates within the
 * caller's `tx`; the F4 CN bridge manages its own transaction.
 */
import { err, ok, type Result } from '@/lib/result';
import type { Satang } from '@/lib/money';
// Track B — the waiver vocabulary is F4 Domain's, consumed through the barrel.
// 8B — `InvoiceStatus` too, to report a converted-waive refund's real
// post-decline invoice status out to the admin envelope.
import type { CreditNoteWaiverReason, InvoiceStatus } from '@/modules/invoicing';
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
import { paymentsMetrics } from '@/lib/metrics';

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
   * Track B — non-null when F4 owes NO §86/10 ใบลดหนี้ for this refund (the
   * invoice was voided, or the buyer holds a §105 receipt). Read off the
   * refund row, which pinned it in Phase A.
   *
   * REQUIRED, not optional, and deliberately so: every caller must state the
   * answer. Defaulting it to `null` would silently route a waived refund into
   * the credit-note bridge, which refuses it — and a refund that Stripe has
   * already settled then stays `pending` forever, blocking every future refund
   * on the payment. That is the F-3 shape this remediation exists to remove,
   * so it is a compile error instead.
   */
  readonly creditNoteWaiverReason: CreditNoteWaiverReason | null;
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

/**
 * Track B — a DISCRIMINATED result, because a waived refund has no credit note
 * and did not credit the invoice.
 *
 * The waived arm deliberately carries no `invoiceStatus`. Reporting one would
 * mean calling `getInvoiceStatus`, which narrows to the credited pair and
 * errors `unexpected_status` for exactly `paid` and `void` — the two statuses
 * a waive produces. The old flat shape would have forced a filler value, and
 * the filler would have said `credited` for an invoice carrying zero credit
 * notes, on every waived refund.
 */
export type FinalizeSucceededRefundResult =
  | (FinalizeSucceededRefundCommon & {
      readonly documentation: 'credit_note';
      readonly creditNoteId: string;
      readonly creditNoteNumber: string;
      readonly invoiceStatus: 'partially_credited' | 'credited';
    })
  | (FinalizeSucceededRefundCommon & {
      readonly documentation: 'waived';
      readonly waiverReason: CreditNoteWaiverReason;
      /**
       * 8B — present ONLY when this refund was CONVERTED to a waive on a
       * Phase-B decline (a concurrent void landed in the TOCTOU window). Carries
       * F4's real post-decline invoice status (`void`) so the admin envelope
       * reports the truth instead of the `paid` placeholder pinned at pre-flight.
       * Absent on the ordinary pre-pinned-waive path, where the caller's
       * pre-flight status is already correct.
       */
      readonly invoiceStatus?: InvoiceStatus;
    });

interface FinalizeSucceededRefundCommon {
  readonly paymentNextStatus: 'partially_refunded' | 'refunded';
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
  // B.2 (tax#5) — `getInvoiceStatus` reads F4's authoritative post-CN invoice
  // status (see the payment-flip / return sections). Both callers pass their
  // full `InvoicingBridgePort`, so the wider `Pick` is satisfied.
  // 8B — `getInvoiceCreditedTotal` is re-read on a Phase-B decline to consult
  // F4's Domain verdict (has the invoice become `waive`-eligible in the TOCTOU
  // window?). Both callers pass their full `InvoicingBridgePort`.
  readonly invoicingBridge: Pick<
    InvoicingBridgePort,
    'issueCreditNoteFromRefund' | 'getInvoiceStatus' | 'getInvoiceCreditedTotal'
  >;
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
  // Track B — WHAT DOCUMENTS THIS REFUND. Either F4 issues a §86/10 ใบลดหนี้,
  // or none is owed and the waiver is stamped instead. The DB enforces that it
  // is exactly one of the two (`refunds_cn_xor_waived`).
  //
  // The waive path skips BOTH external calls below, and skipping the SECOND is
  // not an optimisation — `getInvoiceStatus` narrows to the credited pair and
  // errors `unexpected_status` for exactly `paid` and `void`, which are the two
  // statuses the waive arm produces. Calling it would log an ERROR on the
  // designed happy path and then report `credited` for an invoice carrying zero
  // credit notes, on 100% of waived refunds.
  const waiverReason = input.creditNoteWaiverReason;

  // 8B (money-remediation) — set when a Phase-B credit-note decline is
  // re-consulted and F4's Domain verdict has become `waive`: a concurrent
  // `voidInvoice` committed in the window between Phase A's pre-flight (verdict
  // `issue`) and this credit note, so the invoice now owes NO §86/10. Carries
  // the reason + the invoice's real post-decline status out to the envelope +
  // the forensic. `null` on every path that did not convert (pre-pinned waive,
  // clean credit note, or a decline that DID NOT flip to `waive`).
  let convertedWaive: {
    readonly reason: CreditNoteWaiverReason;
    readonly invoiceStatus: InvoiceStatus;
  } | null = null;

  // `resolveInvoiceStatus` is CARRIED BY the credit-note arm rather than living
  // in a sibling binding, so the waive arm structurally does not have one to
  // call. The previous shape kept them apart and gave the waive arm a stub that
  // threw, under a comment asserting the stub was unreachable — and a call site
  // added later (the ADMIN envelope's status, below) reached it on every waived
  // refund. The throw was swallowed by the Phase-B handler and reported as
  // `f4_bridge_deferred`: money out of Stripe, row `pending` forever, sweep
  // retrying into the same throw.
  //
  // A comment cannot hold that invariant. One discriminant can: narrowing to
  // `kind === 'credit_note'` is now the only way to obtain the resolver, so the
  // compiler refuses a waive-path call instead of a test having to catch it.
  //
  // The resolver prefers F4's authoritative post-CN status and falls back to the
  // payment-derived projection, so a transient read hiccup cannot fail an
  // already-succeeded refund.
  let documentation:
    | {
        readonly kind: 'credit_note';
        readonly id: string;
        readonly number: string;
        readonly resolveInvoiceStatus: (
          fallbackNextStatus: 'partially_refunded' | 'refunded',
        ) => 'partially_credited' | 'credited';
      }
    | { readonly kind: 'waived'; readonly reason: CreditNoteWaiverReason };

  if (waiverReason === null) {
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
      // 8B — a decline is NOT automatically a dead-end. Stripe has already
      // settled the money; deferring a refund whose invoice can never take a
      // credit note strands the row `pending` forever (sweep retrying into the
      // same permanent refusal) and blocks every future refund on the payment.
      //
      // Re-consult F4's Domain verdict: if the invoice has flipped to `waive`
      // (a concurrent `voidInvoice` landed in the TOCTOU window → no §86/10
      // owed), CONVERT to a clean waived-success. Any OTHER outcome — verdict
      // still `issue`/`blocked` (a genuine over-credit) or the re-read errored —
      // DEFERS exactly as before. Fail-closed: a real over-credit is never
      // silently waived, because only an explicit `waive` verdict converts.
      //
      // The read threads the caller's `tx` (B.1 lesson: no nested pooled
      // connection while row locks are held; READ COMMITTED, so it sees the
      // just-committed void). It takes NO lock (plain aggregate read), so it
      // cannot invert the finaliser's refund→invoice lock order.
      const recheck = await deps.invoicingBridge.getInvoiceCreditedTotal({
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        externalTx: tx,
      });
      const requirement = recheck.ok
        ? recheck.value.creditNoteRequirement
        : null;
      if (requirement === null || requirement.kind !== 'waive') {
        return err({ code: cnResult.error.code, detail: cnResult.error.detail });
      }
      convertedWaive = {
        reason: requirement.reason,
        invoiceStatus: requirement.invoiceStatus,
      };
      documentation = { kind: 'waived', reason: requirement.reason };
    } else {
      // --- Step 1b: F4-AUTHORITATIVE invoice status (tax#5, B.2) -----------
      // The CN above committed in F4's own tx (it ran `applyCreditNoteRollup` →
      // flipped the invoice to `credited`/`partially_credited`). Read that
      // authoritative status HERE — threading the caller's `tx` (B.1 lesson: no
      // nested pooled connection while row locks are held; the finalise tx is
      // READ COMMITTED so it sees F4's just-committed flip). We source the status
      // from F4 instead of projecting the F5 payment status because the payment
      // status is blind to a pre-existing MANUAL F4 credit note.
      const f4StatusResult = await deps.invoicingBridge.getInvoiceStatus({
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        externalTx: tx,
      });
      documentation = {
        kind: 'credit_note',
        id: cnResult.value.creditNoteId,
        number: cnResult.value.creditNoteNumber,
        resolveInvoiceStatus: (fallbackNextStatus) =>
          f4StatusResult.ok
            ? f4StatusResult.value
            : fallbackNextStatus === 'refunded'
              ? 'credited'
              : 'partially_credited',
      };
    }
  } else {
    documentation = { kind: 'waived', reason: waiverReason };
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
    // Exactly ONE instrument documents the refund; the DB enforces the XOR.
    // 8B — the waived arm writes BOTH the completion timestamp AND the reason.
    // On the ordinary pre-pinned-waive path the reason is already on the row
    // (idempotent re-write); on a CONVERTED waive Phase A pinned it NULL (it
    // took the `issue` arm), so this write is load-bearing — omit it and
    // `refunds_waived_at_requires_reason` aborts the Phase-B tx.
    ...(documentation.kind === 'credit_note'
      ? { creditNoteId: documentation.id }
      : {
          creditNoteWaivedAt: completedAt,
          creditNoteWaiverReason: documentation.reason,
        }),
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
      ...(documentation.kind === 'credit_note'
        ? {
            documentation: 'credit_note' as const,
            creditNoteId: documentation.id,
            creditNoteNumber: documentation.number,
            // tax#5 (B.2) — F4-authoritative (the sibling's CN already flipped
            // the invoice); fall back to the payment projection on a read error.
            invoiceStatus: documentation.resolveInvoiceStatus(reportedNextStatus),
          }
        : {
            documentation: 'waived' as const,
            waiverReason: documentation.reason,
            // 8B — carry the converted post-void status even when a sibling
            // won the flip, so the admin envelope still reports the truth.
            ...(convertedWaive
              ? { invoiceStatus: convertedWaive.invoiceStatus }
              : {}),
          }),
      paymentNextStatus: reportedNextStatus,
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

  // tax#5 (B.2): invoice status is sourced from F4 (authoritative) via the
  // Step-1b read, NOT projected from the resolved payment status. Falls back to
  // the payment projection only if the F4 read errored (see `resolveInvoiceStatus`).
  //
  // Track B — THIS is the call site that reached the old throwing stub. On the
  // waive path there is no post-credit-note status to report: no credit note was
  // issued, so the invoice's status is unchanged by this refund. `null` says
  // exactly that. A filler value would have the audit trail assert an invoice
  // transition that never happened, on every waived refund.
  //
  // Resolved ONCE into the same discriminated value, so the audit payload and
  // the returned envelope cannot report different statuses for one refund.
  const documented =
    documentation.kind === 'credit_note'
      ? {
          ...documentation,
          invoiceStatus: documentation.resolveInvoiceStatus(resolvedNextStatus),
        }
      : documentation;

  // --- Step 4: audit refund_succeeded (path-discriminated) -----------------
  await deps.audit.emit(tx, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'refund_succeeded',
    actorUserId: input.actorUserId,
    summary:
      documentation.kind === 'credit_note'
        ? `Refund ${input.refundId} succeeded — credit note ${documentation.number} issued for ${input.amountSatang.toString()} satang`
        : // Deliberately does NOT contain the words "credit note … issued".
          // This summary is what a human reads in the audit viewer, and on this
          // path no credit note exists; the waiver ground is the fact worth
          // surfacing, and `refund_credit_note_waived` carries the detail.
          `Refund ${input.refundId} succeeded — no credit note owed (${documentation.reason}) for ${input.amountSatang.toString()} satang`,
    payload: {
      path: input.path,
      refund_id: input.refundId,
      payment_id: input.paymentId,
      invoice_id: input.invoiceId,
      processor_refund_id: input.processorRefundId,
      credit_note_id: documented.kind === 'credit_note' ? documented.id : null,
      credit_note_number:
        documented.kind === 'credit_note' ? documented.number : null,
      ...(documented.kind === 'waived'
        ? { credit_note_waiver_reason: documented.reason }
        : {}),
      amount_satang: input.amountSatang.toString(),
      payment_next_status: resolvedNextStatus,
      invoice_next_status:
        documented.kind === 'credit_note' ? documented.invoiceStatus : null,
    },
    retentionYears: retentionFor('refund_succeeded'),
  });

  // 8B — CONVERTED-waive forensic. On the ordinary pre-pinned-waive path this
  // 10-year row is emitted in Phase A (issueRefund, before Stripe); a refund
  // that only became a waive HERE (a concurrent void raced the credit note) has
  // no Phase-A forensic, so emit it now beside `refund_succeeded`. Winner-only
  // (the sibling-won branch returned above at the `updatedRefund === null`
  // guard), which keeps the counter ↔ forensic 1:1 the same way the caller
  // gates `refundSucceededCount` on `siblingWon === false`. A sibling that won
  // the flip and also converted owns its own forensic on its own winning call.
  if (convertedWaive !== null) {
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'refund_credit_note_waived',
      actorUserId: input.actorUserId,
      summary: `Refund ${input.refundId} carries no credit note (${convertedWaive.reason}) on invoice ${input.invoiceId}`,
      payload: {
        refund_id: input.refundId,
        payment_id: input.paymentId,
        invoice_id: input.invoiceId,
        amount_satang: input.amountSatang.toString(),
        waiver_reason: convertedWaive.reason,
        invoice_status: convertedWaive.invoiceStatus,
        runbook_url: 'docs/runbooks/refund-without-credit-note.md',
      },
      retentionYears: retentionFor('refund_credit_note_waived'),
    });
    paymentsMetrics.refundCreditNoteWaivedCount(
      input.tenantId,
      convertedWaive.reason,
    );
  }

  return ok({
    ...(documented.kind === 'credit_note'
      ? {
          documentation: 'credit_note' as const,
          creditNoteId: documented.id,
          creditNoteNumber: documented.number,
          invoiceStatus: documented.invoiceStatus,
        }
      : {
          documentation: 'waived' as const,
          waiverReason: documented.reason,
          // 8B — the converted-waive path threads F4's real post-void status
          // ('void'); the pre-pinned-waive path leaves it absent (the caller's
          // pre-flight status is already correct).
          ...(convertedWaive
            ? { invoiceStatus: convertedWaive.invoiceStatus }
            : {}),
        }),
    paymentNextStatus: resolvedNextStatus,
    siblingWon: false,
  });
}
