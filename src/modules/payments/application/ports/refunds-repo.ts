/**
 * T054 — RefundsRepo port (F5 Application).
 *
 * Minimal surface needed by Group D use-cases (initiate / confirm / fail /
 * cancel paths do NOT touch refunds — Group E / F ship the full refund
 * use-case). The methods below exist to support the webhook-side
 * `charge.refunded` branch + future refund use-case.
 */
import type { PaymentId } from '../../domain/payment';
// Single source of truth — Domain owns the status enum so a future
// `'voided'` addition (post-MVP) cannot drift between Domain + Port.
import type { Refund, RefundStatus } from '../../domain/refund';
import type { RejectionProof } from '../../domain/settlement/money-moved';
import type { Satang } from '@/lib/money';
// Track B — the waiver vocabulary is owned by F4 Domain (it encodes §86/10
// rules), consumed here through the published barrel.
import type { CreditNoteWaiverReason } from '@/modules/invoicing';
export type { RefundStatus };

export interface RefundRow {
  readonly id: string;
  readonly tenantId: string;
  readonly paymentId: PaymentId;
  readonly invoiceId: string;
  readonly amountSatang: Satang;
  readonly status: RefundStatus;
  readonly processorRefundId: string | null;
}

interface UpdateRefundStatusBase {
  readonly refundId: string;
  readonly tenantId: string;
  readonly processorRefundId?: string | null;
  readonly failureReasonCode?: string | null;
  readonly creditNoteId?: string | null;
  /**
   * Track B — stamped ONLY on the succeeded flip of a refund that owes no
   * §86/10 ใบลดหนี้. Mutually exclusive with `creditNoteId` (DB CHECK
   * `refunds_cn_xor_waived`), and it is this timestamp — never the waiver
   * REASON written at insert — that the completeness CHECK keys on. See
   * migration 0268 for why: reason-keying makes an intermediate `pending` row
   * violate the biconditional after Stripe has already moved the money.
   */
  readonly creditNoteWaivedAt?: Date | null;
  readonly completedAt: Date;
  /**
   * Optional optimistic-concurrency guard (S5 / RR-1). When set, the
   * UPDATE additionally filters `WHERE status = expectedCurrentStatus`.
   * Zero rows matched → repo returns `null` (NOT throw) so the caller
   * can distinguish a lost race from a genuine error. When omitted,
   * the adapter throws on zero-match (preserves throw-on-zero
   * semantics for callers that re-check under their own lock).
   *
   * Used by `sweepStalePendingRefunds` to ensure the sweep does
   * not flip a row that has been concurrently finalised to
   * `succeeded`/`failed` by a different writer (e.g. the webhook
   * `charge.refunded` branch or issueRefund's Phase B).
   *
   * CONTRACT (mirrors `payments-repo.updateStatus` H-4): every
   * caller passing `expectedCurrentStatus` MUST handle the `null`
   * return branch. The sweep re-throws a sentinel on `null` so its
   * per-row tx rolls back and no `stale_pending_refund_detected`
   * audit commits.
   */
  readonly expectedCurrentStatus?: RefundStatus;
}

/**
 * Writing `failed` requires evidence, not intent (money-remediation F-3).
 *
 * A `failed` refund row is read downstream as "no money left the account":
 * it is excluded from `succeeded_sum_satang`, does not trip the
 * `refund_in_progress` guard, and is counted by the sequence that used to
 * derive the Stripe idempotency key. Marking a settled refund `failed`
 * therefore clears every guard that would stop the next attempt from paying
 * the customer a second time.
 *
 * The `rejectionProof` requirement is what makes that a COMPILE error rather
 * than a code-review question. The brand is module-private to
 * `domain/settlement/money-moved.ts`, so the only way to obtain one is to
 * hold real evidence:
 *   - `proveNothingMoved(classifyGatewayFailure(err))` — the processor refused
 *   - `proveProcessorSettledFailed(status)` — the processor settled it failed
 *
 * A test stub NEVER needs to construct a proof: stubs receive this input, they
 * do not build it. If you find yourself wanting to export the brand to make a
 * stub compile, the stub is being written against the wrong seam — that
 * export would turn this guard back into decoration with every test green.
 */
export type UpdateRefundStatusInput =
  | (UpdateRefundStatusBase & {
      readonly nextStatus: Exclude<RefundStatus, 'failed'>;
    })
  | (UpdateRefundStatusBase & {
      readonly nextStatus: 'failed';
      readonly rejectionProof: RejectionProof;
    });

export interface RefundsRepo {
  insert(
    tx: unknown,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly paymentId: PaymentId;
      readonly invoiceId: string;
      readonly amountSatang: Satang;
      readonly reason: string;
      readonly status: RefundStatus;
      readonly processorRefundId: string | null;
      readonly initiatorUserId: string;
      readonly correlationId: string;
      /**
     * Track B — waiver INTENT: non-null when F4 owes NO §86/10 ใบลดหนี้ for
     * this refund (the invoice was voided, or the buyer holds a §105 receipt).
     * Written with the still-`pending` row; the COMPLETION timestamp
     * (`creditNoteWaivedAt`) is stamped separately on the succeeded flip, and
     * the DB completeness CHECK keys on that timestamp rather than on this
     * column — see migration 0268.
     */
    readonly creditNoteWaiverReason: CreditNoteWaiverReason | null;
    readonly initiatedAt: Date;
    },
  ): Promise<RefundRow>;

  updateStatus(
    tx: unknown,
    input: UpdateRefundStatusInput,
  ): Promise<RefundRow | null>;

  /** Look up an existing refund by Stripe refund id (dedupe webhook re-delivery). */
  findByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<RefundRow | null>;

  /**
   * A.6 — narrow write: set ONLY `processor_refund_id`, leaving
   * `status` and `completed_at` untouched (a refund row is inserted
   * `status='pending'` before Stripe assigns a refund id; this method
   * durably records that id as soon as the processor accepts the
   * request, ahead of the eventual succeeded/failed outcome).
   *
   * CHECK-safe by design: `refunds_succeeded_iff_complete` is the
   * biconditional `(status='succeeded') = (processor_refund_id IS NOT
   * NULL AND credit_note_id IS NOT NULL)`. With `status` still
   * `'pending'` the LHS is `false`; `credit_note_id` remains NULL so
   * the RHS is also `false` — `false = false` satisfies the
   * constraint regardless of `processor_refund_id`.
   *
   * Throws on zero-match — `refundId` is expected to already exist
   * (the row is inserted via `insert` before this is ever called).
   */
  attachProcessorRefundId(
    tx: unknown,
    input: {
      readonly refundId: string;
      readonly tenantId: string;
      readonly processorRefundId: string;
    },
  ): Promise<void>;

  /**
   * A.6 — `SELECT … WHERE tenant_id = ? AND processor_refund_id = ?
   * FOR NO KEY UPDATE`. Serialises concurrent writers reconciling the same
   * Stripe refund (e.g. a `refund.updated` webhook racing the
   * stale-pending sweep or `issueRefund` Phase B).
   *
   * A.18 — the strength is `FOR NO KEY UPDATE`, NOT `FOR UPDATE`. The caller
   * holds this lock across `finalizeSucceededRefund`, whose F4 credit-note
   * bridge INSERTs `credit_notes.source_refund_id → refunds.id` from a
   * SEPARATE connection; that FK check needs `FOR KEY SHARE` on this row.
   * `FOR UPDATE` conflicts with `FOR KEY SHARE` → an undetectable
   * cross-connection hang; `FOR NO KEY UPDATE` does not (and still serialises
   * concurrent reconcilers). Safe because the reconciler only mutates
   * non-key columns. See the adapter for the full rationale + repro.
   *
   * Returns the full Domain `Refund` aggregate (NOT the port's slim
   * `RefundRow`) — the webhook reconcile use-case needs every
   * state-machine-relevant field (`reason`, `failureReasonCode`,
   * `creditNoteId`, timestamps) to decide the next transition, not
   * just the aggregate-context subset `RefundRow` carries.
   */
  lockForUpdateByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<Refund | null>;

  /**
   * Combined aggregate snapshot for a (tenant, payment) tuple,
   * computed in ONE SELECT under the payment-row FOR UPDATE lock.
   * Used by `issueRefund` (T108) — replaces the previous trio of
   * `countPendingForPayment` + `sumSucceededForPayment` +
   * `nextRefundSeq` so the lock-hold window does not absorb 3
   * separate roundtrips.
   *
   * Returns:
   *   - `pendingCount` — # of refunds with status='pending'.
   *     `> 0` → use-case rejects with `refund_in_progress`.
   *   - `succeededSumSatang` — Σ amount_satang WHERE status='succeeded'.
   *     Drives the FR-011b remaining-refundable invariant.
   *   - `nextSeq` — `COUNT(*) + 1` over all rows in the partition.
   *     RETAINED for forensics only. It no longer derives the Stripe
   *     idempotency key: `COUNT(*)` counts terminal rows too, so the key
   *     rotated across retries and turned a partial-refund retry into a
   *     genuine second payout (F-3 leg 3). The key is now `rfnd-{refundId}`,
   *     stable per logical attempt.
   *   - `settledUnbookedCount` — rows left in the F-3 casualty state by the
   *     pre-remediation code. See the field's own note.
   *
   * Caller MUST invoke inside the tx that holds the
   * `SELECT … FOR UPDATE` on `payments(id)` so all reads see
   * the same committed snapshot.
   */
  getRefundContextForUpdate(
    tx: unknown,
    tenantId: string,
    paymentId: PaymentId,
  ): Promise<{
    readonly pendingCount: number;
    readonly succeededSumSatang: Satang;
    readonly nextSeq: number;
    /**
     * Rows this payment carries in the F-3 casualty state: `failed`, but
     * with a `processor_refund_id` AND a `f4_bridge_%` failure reason —
     * i.e. Stripe settled the money and the pre-remediation code
     * terminalised the row anyway. Money moved that no aggregate here can
     * see, so the remaining-refundable invariant is computed against a
     * total that is too low.
     *
     * Deliberately NOT folded into `succeededSumSatang`: that aggregate is
     * also read by `finalizeSucceededRefund` in webhook mode, and inflating
     * it would flip a payment to `refunded` on money that never settled.
     */
    readonly settledUnbookedCount: number;
  }>;

  /**
   * T130a — list refunds in `pending` status older than the cutoff.
   * Used by the stale-pending-refund sweep cron to flip orphaned
   * pending rows to `failed` so they don't permanently block future
   * refunds on the same payment via the `refund_in_progress` guard.
   *
   * Tenant-scoped; reads run under `runInTenant` so RLS+FORCE
   * filters cross-tenant rows. The cron's caller iterates active
   * tenants and calls this once per tenant.
   *
   * Returns the minimum fields the sweep + audit emit need; the row
   * is updated in a separate `updateStatus` call inside the same
   * tx as the audit emit for atomicity.
   *
   * A.14 — `processorRefundId` (the Stripe `re_…` id, nullable) is
   * surfaced so the Stripe-aware sweep can `retrieveRefund` the real
   * outcome and finalise the row instead of blind-failing it. It is
   * NULL only in the rare window where `issueRefund` inserted the
   * pending row + Stripe accepted the refund but the `attachProcessorRefundId`
   * tx crashed before persisting the id — those rows cannot be
   * reconciled against Stripe and are skipped by the sweep (never
   * blind-failed — a real refund may exist).
   */
  /**
   * Money-remediation Task 9 (F-9) — resolve a refund row by the
   * APP-INITIATED marker (`refunds.id`, echoed back to us as the Stripe
   * Refund's `metadata.refundId`) instead of by `processor_refund_id`.
   *
   * WHY IT EXISTS. `issueRefund` writes `processor_refund_id` in a
   * SEPARATE tx AFTER `createRefund` returns. Between the Stripe call and
   * that write, a `charge.refunded` / `refund.updated` delivery finds no
   * row by `processor_refund_id` and the handler fires a FALSE
   * `out_of_band_refund_detected` — a 10-year forensic claiming money left
   * by an unauthorised route, plus an on-call page, for a refund we
   * initiated. The marker is the only key that exists BEFORE the external
   * call, so it is the only key that closes the window. It also closes the
   * durable variant, where the attach write never lands at all
   * (`attachProcessorRefundId` throws on zero rows and has no try/catch, so
   * a Neon blip or function timeout strands the row NULL forever and every
   * delivery in Stripe's ~3-day retry series re-fires the false forensic).
   *
   * `WHERE processor_refund_id IS NULL` IS LOAD-BEARING — DO NOT RELAX IT.
   * The caller's input is attacker-influenceable: anyone with Stripe
   * Dashboard access (the exact actor the OOB alert exists to catch) can
   * set `metadata.refundId` on a hand-made refund and try to mute their own
   * alarm. This predicate makes the method STRUCTURALLY INCAPABLE of
   * returning a row that already carries a processor id, so a forged marker
   * can never re-point, re-attach, or launder an already-matched refund —
   * the worst it can do is name a row that is genuinely still awaiting its
   * id, which the caller then rejects on the PaymentIntent cross-check.
   * Widening this to "find by id" would turn a false-alarm fix into an
   * alarm-suppression primitive.
   *
   * Tenant isolation is two-layer per Principle I: the `tx` carries
   * `SET LOCAL app.current_tenant` (RLS + FORCE) AND both tables are
   * explicitly filtered on `tenantId`. A forged marker naming another
   * tenant's refund must return null — and the caller must still emit the
   * forensic, because that is a cross-tenant probe, not a benign miss.
   *
   * Returns the parent payment's `processorPaymentIntentId` so the caller
   * can complete the anti-forgery cross-check in ONE query, without taking
   * a lock (this runs inside a webhook dispatch tx; adding a second lock
   * acquisition here would introduce an ordering hazard with
   * `lockForUpdateByProcessorRefundId`).
   *
   * `status` is returned rather than filtered in SQL so the caller can
   * decide explicitly: a terminal row with a NULL processor id was
   * finalised under a rejection proof (Stripe said the money never moved),
   * so a settlement webhook naming it is a genuine contradiction that MUST
   * keep its forensic rather than being quietly back-filled.
   */
  findAwaitingAttachByAppRefundId(
    tx: unknown,
    tenantId: string,
    appRefundId: string,
  ): Promise<{
    readonly id: string;
    readonly paymentId: PaymentId;
    readonly invoiceId: string;
    readonly amountSatang: Satang;
    readonly status: RefundStatus;
    /** Parent `payments.processor_payment_intent_id` — cross-check input. */
    readonly parentProcessorPaymentIntentId: string;
  } | null>;

  listPendingOlderThan(
    tx: unknown,
    tenantId: string,
    cutoff: Date,
  ): Promise<
    ReadonlyArray<{
      readonly id: string;
      readonly paymentId: PaymentId;
      readonly invoiceId: string;
      readonly amountSatang: Satang;
      readonly initiatedAt: Date;
      readonly correlationId: string;
      readonly initiatorUserId: string;
      readonly processorRefundId: string | null;
    }>
  >;

  /**
   * Track B — total satang of SUCCEEDED refunds whose §86/10 credit note was
   * WAIVED, grouped by invoice.
   *
   * Exists because F9 nets refunded money out of revenue via
   * `invoices.credited_total_satang`, and a waived refund never touches that
   * column: no credit note is issued, so a §105 invoice stays `paid` at full
   * value after the cash went back. This read is what lets F9 subtract it.
   *
   * WHY IT FILTERS ON THE TIMESTAMP, NOT THE REASON. `credit_note_waiver_reason`
   * is pinned at the Phase-A insert while the row is still `pending`, and the
   * FAILED path keeps it — it records the decision, not the outcome. Only the
   * succeeded flip stamps `credit_note_waived_at`. Filtering on the reason
   * would net money that never moved.
   *
   * NO DOUBLE-COUNT. `refunds_cn_xor_waived` (migration 0268) makes credit-noted
   * and waived mutually exclusive per row, so this total can never overlap
   * `credited_total_satang`. The caller therefore subtracts BOTH terms; picking
   * one over the other would drop a real reversal.
   *
   * Invoices with no waived refund are ABSENT from the map, not zero — the
   * caller defaults with `?? 0n`.
   *
   * Opens its own `runInTenant` (no `tx` param): F9's snapshot cron has no
   * enclosing tenant scope, and nesting one inside another while row locks are
   * held is the deadlock shape this codebase has already paid for once.
   */
  sumWaivedByInvoice(tenantId: string): Promise<ReadonlyMap<string, bigint>>;
}
