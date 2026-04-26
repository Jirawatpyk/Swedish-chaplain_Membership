/**
 * T054 — PaymentsRepo port (F5 Application).
 *
 * Abstract persistence for the `payments` table. Implementation lives in
 * Infrastructure (Group E). Application layer calls these methods only
 * through this port so use-cases stay ORM-free (Principle III).
 */
import type { Payment, PaymentStatus, PaymentId, CardMetadata } from '../../domain/payment';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';

export interface PaymentsRepo {
  /** Run `fn` inside a serializable transaction; rollback on throw. */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /** `SELECT … FOR UPDATE` by id; returns null when row missing. */
  lockForUpdate(tx: unknown, paymentId: PaymentId, tenantId: string): Promise<Payment | null>;

  /** `SELECT … FOR UPDATE` by Stripe PaymentIntent id; tenant-scoped via RLS. */
  lockForUpdateByPaymentIntentId(tx: unknown, paymentIntentId: string): Promise<Payment | null>;

  /** Insert a new pending payment row. */
  insert(
    tx: unknown,
    input: {
      readonly id: PaymentId;
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly memberId: string;
      readonly method: PaymentMethod;
      readonly amountSatang: bigint;
      readonly processorPaymentIntentId: string;
      readonly processorEnvironment: 'test' | 'live';
      readonly attemptSeq: number;
      readonly initiatedAt: Date;
      readonly actorUserId: string;
      readonly correlationId: string;
    },
  ): Promise<Payment>;

  /** Update status + terminal fields. */
  updateStatus(
    tx: unknown,
    input: {
      readonly paymentId: PaymentId;
      readonly tenantId: string;
      readonly nextStatus: PaymentStatus;
      readonly processorChargeId?: string | null;
      readonly card?: CardMetadata | null;
      readonly failureReasonCode?: string | null;
      readonly completedAt: Date;
    },
  ): Promise<Payment>;

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
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amountSatang: bigint;
  readonly reason: string;
  readonly initiatedAt: Date;
  readonly completedAt: Date | null;
  readonly initiatorUserId: string;
  readonly processorRefundId: string | null;
  readonly failureReasonCode: string | null;
  readonly creditNoteId: string | null;
}
