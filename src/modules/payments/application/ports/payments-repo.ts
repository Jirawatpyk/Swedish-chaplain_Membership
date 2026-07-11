/**
 * PaymentsRepo port (F5 Application).
 *
 * Abstract persistence for the `payments` table. Implementation lives in
 * Infrastructure (Group E). Application layer calls these methods only
 * through this port so use-cases stay ORM-free (Principle III).
 */
import type { Payment, PaymentStatus, PaymentId, CardMetadata } from '../../domain/payment';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';
import type { RefundStatus } from '../../domain/refund';
import type { Satang } from '@/lib/money';

export interface PaymentsRepo {
  /** Run `fn` inside a serializable transaction; rollback on throw. */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /**
   * R2 fix (2026-04-27): advisory tx-lock on a stable hash of
   * (tenantId, invoiceId). Used by `initiatePayment` to serialise
   * concurrent callers for the same invoice so the findPending /
   * createPaymentIntent / insert sequence is race-free. Lock
   * auto-releases at tx end.
   */
  acquireInitiateLock(tx: unknown, tenantId: string, invoiceId: string): Promise<void>;

  /** `SELECT … FOR UPDATE` by id; returns null when row missing. */
  lockForUpdate(tx: unknown, paymentId: PaymentId, tenantId: string): Promise<Payment | null>;

  /**
   * `SELECT … FOR UPDATE` by Stripe PaymentIntent id, tenant-scoped.
   *
   * R3 M-4 (2026-04-28): added explicit `tenantId` parameter so the
   * port contract surfaces Constitution Principle I sub-clause #1
   * (application-layer tenant scoping) at the type level. The
   * factory implementation already applied this filter via closure
   * (CR-2 fix), but the port was silent — a future mock adhering only
   * to the type signature could omit it.
   */
  lockForUpdateByPaymentIntentId(
    tx: unknown,
    paymentIntentId: string,
    tenantId: string,
  ): Promise<Payment | null>;

  /** Insert a new pending payment row. */
  insert(
    tx: unknown,
    input: {
      readonly id: PaymentId;
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly memberId: string;
      readonly method: PaymentMethod;
      readonly amountSatang: Satang;
      readonly processorPaymentIntentId: string;
      readonly processorEnvironment: 'test' | 'live';
      readonly attemptSeq: number;
      readonly initiatedAt: Date;
      readonly actorUserId: string;
      readonly correlationId: string;
    },
  ): Promise<Payment>;

  /**
   * Update status + terminal fields.
   *
   * F5R2-CRIT-1 — `expectedCurrentStatus` is a defence-in-depth WHERE
   * clause (`payments.status = expectedCurrentStatus`). When provided
   * AND the row's current status no longer matches (e.g., a webhook
   * flipped pending→succeeded between the caller's lockForUpdate and
   * this update), the UPDATE matches zero rows and the adapter returns
   * `null` so the caller can detect the race. When omitted, the
   * adapter throws on zero-match (preserves existing call-site
   * semantics for sites that re-check via canTransition under their
   * own lock).
   *
   * The cancel-payment Phase B race that motivated the addition: a
   * succeeded webhook lands between Phase A release and Phase B
   * re-lock; without this guard the adapter silently overwrote a
   * succeeded payment with `canceled`, breaking SC-013 invariant
   * (charged customer + DB says canceled).
   *
   * F5R3 H-4 (2026-05-16) — type-design reviewer flagged the loose
   * return-nullability contract: callers without `expectedCurrentStatus`
   * must currently defend against a `null` they cannot actually
   * receive (the adapter throws on zero match in that path). A
   * function-overload split (with-expected → `Promise<Payment | null>`
   * vs without-expected → `Promise<Payment>`) was attempted but TS
   * couldn't statically prove the adapter's runtime-throw narrows the
   * union — the impl had to return `Promise<Payment | null>` to
   * satisfy the wider overload, defeating the purpose. The unified
   * `expectedCurrentStatus?` form is preserved; H-4 closed as
   * "design-debt accepted" with this docstring as the only artifact.
   * Mitigation: every caller passing `expectedCurrentStatus` MUST
   * also handle the `null` race branch (enforced by code-review +
   * `if (updated !== null)` patterns at every call site).
   */
  updateStatus(
    tx: unknown,
    input: {
      readonly paymentId: PaymentId;
      readonly tenantId: string;
      readonly nextStatus: PaymentStatus;
      readonly expectedCurrentStatus?: PaymentStatus;
      readonly processorChargeId?: string | null;
      readonly card?: CardMetadata | null;
      readonly failureReasonCode?: string | null;
      readonly completedAt: Date;
    },
  ): Promise<Payment | null>;

  /**
   * A.13 (#3 / CRITICAL-2) — terminalise a stuck-pending payment as
   * `auto_refunded` + durably record the Stripe refund id, in ONE guarded
   * UPDATE.
   *
   * Used by the confirm-payment stale-invoice auto-refund tail (Phase B):
   * after Stripe accepts the FULL refund of a payment whose invoice is no
   * longer payable (voided / credited / paid out-of-band), this write
   *   1. flips the row `pending → auto_refunded` (a TERMINAL state — A.4;
   *      NOT in the succeeded lineage, so `one_succeeded_per_invoice` is
   *      untouched and the member may retry payment on the same invoice);
   *   2. stamps `auto_refund_processor_refund_id = processorRefundId` (the
   *      `re_…` id) so a later `charge.refund.updated` webhook recognises
   *      the auto-refund via `findAutoRefundByProcessorRefundId` (A.6/A.11)
   *      instead of firing a false out-of-band alert;
   *   3. sets `completed_at` — migration 0033's CHECK
   *      `payments_completed_at_iff_not_pending` requires it on any
   *      non-pending status (the flip is rejected by live Postgres without
   *      it).
   *
   * Guarded UPDATE `WHERE id = ? AND tenant_id = ? AND status = 'pending'`
   * (`expectedCurrentStatus='pending'` semantics). Zero rows matched — a
   * concurrent writer already terminalised the row between the caller's
   * Phase-A lock release and this write — returns `null` (mirrors
   * `updateStatus`'s `expectedCurrentStatus` null-return contract; the
   * caller decides the recovery path). Card metadata is left untouched:
   * migration 0240 relaxed `payments_card_metadata_iff_card` to permit
   * `method='card' + status='auto_refunded' + NULL card metadata`, so a
   * stuck-pending card payment (which never captured `card_*`) terminalises
   * without a Stripe re-fetch.
   *
   * Runs inside the caller's webhook-dispatch tx (thread `tx`) so the flip
   * + the `payment_auto_refunded_*` audit + `markProcessed` commit
   * atomically.
   */
  markAutoRefunded(
    tx: unknown,
    input: {
      readonly paymentId: PaymentId;
      readonly tenantId: string;
      readonly processorRefundId: string;
      readonly completedAt: Date;
    },
  ): Promise<Payment | null>;

  /**
   * A.15 (#8 resume-race) — durably stamp `auto_refund_processor_refund_id`
   * on a payment row that is ALREADY terminal `failed`, WITHOUT changing its
   * status (architect decision F-9: NO `failed → auto_refunded` edge).
   *
   * Used by the confirm-payment `failed → succeeded` late-charge reconcile
   * tail (Phase B): a late `payment_intent.succeeded` captured funds against
   * a payment that had already committed `failed`; after Stripe accepts the
   * auto-refund, this write records the `re_…` id on the STILL-`failed` row
   * so the auto-refund's own later `charge.refund.updated` webhook is
   * recognised via `findAutoRefundByProcessorRefundId` (A.6/A.11) instead of
   * firing a false out-of-band alert (RR-6).
   *
   * Guarded UPDATE `WHERE id = ? AND tenant_id = ? AND status = 'failed'
   * AND auto_refund_processor_refund_id IS NULL` (status-preserving —
   * `status` is NOT touched, so F-9 holds; `completed_at` is untouched and
   * already satisfies migration 0033's `payments_completed_at_iff_not_pending`
   * because the row is non-pending). The `IS NULL` predicate makes a Stripe
   * retry idempotent (the same `re_…` id from the idempotency key does not
   * overwrite an existing marker; the partial-unique index
   * `payments_auto_refund_processor_refund_id_uniq` is the DB backstop).
   *
   * Zero rows matched — a concurrent writer changed the row off `failed`
   * OR a marker was already stamped — returns `null` (mirrors
   * `markAutoRefunded`'s guard-miss contract; the caller warns + reconciles,
   * since the Stripe refund DID happen and the audit is the durable trail).
   * Migration 0240's CHECKs are status-agnostic for this column (no CHECK
   * ties `auto_refund_processor_refund_id` to status), so writing it on a
   * `failed` row is valid.
   *
   * Runs inside the caller's webhook-dispatch tx (thread `tx`) so the marker
   * write + the `payment_auto_refunded_stale_invoice` forensic audit +
   * `markProcessed` commit atomically.
   */
  attachAutoRefundMarkerOnFailed(
    tx: unknown,
    input: {
      readonly paymentId: PaymentId;
      readonly tenantId: string;
      readonly processorRefundId: string;
    },
  ): Promise<Payment | null>;

  /**
   * Resume lookup: find the single pending payment for an (invoice, actor)
   * tuple. Returns null when no resumable attempt exists (idempotency key
   * for `POST /api/payments/initiate` resume per payments-api.md § 1).
   *
   * Reliability D-01 (Group E1, 2026-04-24): accepts an optional `tx`
   * param so `initiatePayment` can run the resume lookup inside the
   * same serializable snapshot as the subsequent INSERT. Prevents the
   * TOCTOU where two concurrent clicks both miss the pending row and
   * both insert a new attempt.
   */
  findPendingByInvoiceAndActor(
    tenantId: string,
    invoiceId: string,
    actorUserId: string,
    tx?: unknown,
  ): Promise<Payment | null>;

  /**
   * Count existing payments in the succeeded lineage for (tenant,invoice)
   * EXCLUDING `excludePaymentId` — input to the one-succeeded-per-invoice
   * invariant check (`enforceOneSucceededPerInvoice`).
   */
  listSiblingStatusesForInvariant(
    tx: unknown,
    tenantId: string,
    invoiceId: string,
    excludePaymentId: PaymentId,
  ): Promise<readonly PaymentStatus[]>;

  /**
   * Next attempt-sequence number for (tenant,invoice). Derives the Stripe
   * idempotency key `inv-<invoiceId>-attempt-<seq>` — monotonic, no gaps
   * relied on. Callers invoke inside a tx to avoid race.
   */
  nextAttemptSeq(tx: unknown, tenantId: string, invoiceId: string): Promise<number>;

  /**
   * F5 US3 reconciliation badge — return the succeeded payment method
   * (card or promptpay) for each invoice in the input set that has at
   * least one succeeded payment. Invoices with no succeeded payment are
   * ABSENT from the returned map.
   *
   * If multiple succeeded payments exist for the same invoice (e.g. an
   * earlier success was followed by a separate refund + re-attempt),
   * the latest by `completed_at` wins. The one-succeeded-per-invoice
   * invariant means this collision is rare in practice but the ordering
   * is deterministic.
   */
  listSucceededMethodByInvoiceIds(
    tenantId: string,
    invoiceIds: readonly string[],
  ): Promise<ReadonlyMap<string, PaymentMethod>>;

  /**
   * F5 US3 timeline panel — return all payment + refund rows tied to
   * the invoice, ordered by initiation time ascending. Refunds carry
   * the parent paymentId; UI groups refunds under their parent in the
   * timeline. Read-only projection — no Refund domain entity since
   * Group F has not landed; the DTO `RefundActivityDto` is defined on
   * the use-case side.
   */
  listInvoiceActivity(
    tenantId: string,
    invoiceId: string,
  ): Promise<{
    readonly payments: readonly Payment[];
    readonly refunds: readonly RefundActivityDto[];
  }>;

  /**
   * H-8 — member-facing refund-notification signal (member-portal
   * display lookup, keyed by invoiceId).
   *
   * Returns the latest `payment_auto_refunded_stale_invoice` audit
   * payload's `processor_refund_id` for `invoiceId`, or null when no
   * matching audit row exists. The portal invoice detail page renders
   * a refund-confirmation sub-section + the truncated refund ref so
   * the member can quote it to their bank. Tenant scoping comes from
   * the factory-bound `ctx` (RLS+FORCE) — caller does not pass tenantId.
   *
   * Authoritative source: `audit_log` (append-only). The F5
   * `refunds.reason` column carries the Stripe enum
   * (`requested_by_customer`) which doesn't disambiguate auto-stale
   * vs manual refunds — the audit row is the only deterministic
   * business-cause signal until a `reason_kind` enum lands (post-MVP).
   *
   * PERMANENT — this is the member-portal display lookup and has a
   * live caller (`src/app/(member)/portal/invoices/[invoiceId]/page.tsx`).
   * It is a distinct lookup from `findAutoRefundByProcessorRefundId`
   * below, not a duplicate pending removal: different key (invoiceId
   * vs processorRefundId) and different purpose (display vs the
   * reconcile-path money decision). Because it reads the append-only
   * audit log directly, it also stays the more-complete forensic
   * source, covering rare cases where the durable
   * `auto_refund_processor_refund_id` marker was never stamped.
   */
  findStaleInvoiceAutoRefund(
    invoiceId: string,
  ): Promise<{ readonly processorRefundId: string | null } | null>;

  /**
   * A.6 — durable auto-refund lookup (migration 0240
   * `auto_refund_processor_refund_id` column) for the webhook
   * reconcile path, keyed by `processorRefundId`.
   *
   * Reads the payments row carrying
   * `auto_refund_processor_refund_id = processorRefundId` and returns
   * its `(paymentId, invoiceId)` — the association the webhook
   * reconcile path needs to locate the auto-refunded payment/invoice
   * without depending on append-only `audit_log` JSON payload shape.
   *
   * Takes an explicit `tx` so callers can run this inside the same tx
   * as their other webhook reconciliation reads/writes.
   *
   * This is a separate, permanent lookup from `findStaleInvoiceAutoRefund`
   * above (different key, different purpose — see that method's
   * docstring) — it is not a replacement that supersedes it.
   */
  findAutoRefundByProcessorRefundId(
    tx: unknown,
    tenantId: string,
    processorRefundId: string,
  ): Promise<{ readonly paymentId: PaymentId; readonly invoiceId: string } | null>;
}

/**
 * Read-only refund DTO used by the F5 reconciliation timeline. Lives
 * on the port file so the Application use-case can depend on it
 * without importing Infrastructure types.
 */
export interface RefundActivityDto {
  readonly refundId: string;
  readonly paymentId: string;
  readonly invoiceId: string;
  // M-6 (review 2026-04-27): import the canonical RefundStatus union
  // from Domain instead of re-declaring inline. Keeps DTO + Domain in
  // lockstep — adding a new refund status (e.g. 'voided') becomes a
  // compile-error here automatically instead of silent drift.
  readonly status: RefundStatus;
  readonly amountSatang: Satang;
  readonly reason: string;
  readonly initiatedAt: Date;
  readonly completedAt: Date | null;
  readonly initiatorUserId: string;
  readonly processorRefundId: string | null;
  readonly failureReasonCode: string | null;
  readonly creditNoteId: string | null;
}
