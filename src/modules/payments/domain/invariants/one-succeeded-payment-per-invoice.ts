/**
 * T052 — One-succeeded-payment-per-invoice invariant (F5).
 *
 * An invoice may have MANY payment attempts (member pays → card declines
 * → retries with a different card), but at most ONE attempt can reach a
 * succeeded lineage state (`succeeded`, `partially_refunded`, or
 * `refunded`). Otherwise F4's `invoices.status` would have to track two
 * different charge lineages simultaneously, and reconciliation would
 * duplicate-count payments against the same invoice.
 *
 * Pure arithmetic check: given an array of existing payment statuses
 * scoped to one invoice_id (+ tenant_id), does adding a new `succeeded`
 * row violate the invariant? The Application layer supplies the
 * `SELECT … FOR UPDATE` on the invoice row to serialise concurrent
 * webhook deliveries.
 *
 * "Succeeded lineage" explicitly EXCLUDES `pending` (attempts still in
 * flight don't count yet) and EXCLUDES `failed`/`canceled` (terminal
 * non-settlement states). This lets a member retry after a failure
 * without the invariant mis-firing.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
import type { PaymentStatus } from '../payment';

const SUCCEEDED_LINEAGE: readonly PaymentStatus[] = [
  'succeeded',
  'partially_refunded',
  'refunded',
];

export type InvariantViolation = {
  readonly kind: 'duplicate_succeeded_payment';
  /** How many existing rows are already in the succeeded lineage. */
  readonly existingSucceededCount: number;
};

/**
 * Precondition check before transitioning a pending payment to
 * succeeded. Returns ok if no other payment on this invoice has already
 * settled; returns err with the existing-succeeded count otherwise.
 *
 * @param existingStatuses — statuses of every OTHER payment row for the
 *   same (tenant_id, invoice_id). MUST NOT include the row being
 *   transitioned (exclude by payment_id at the repository layer).
 */
export function enforceOneSucceededPerInvoice(
  existingStatuses: readonly PaymentStatus[],
): { ok: true } | { ok: false; error: InvariantViolation } {
  let existingSucceededCount = 0;
  for (const s of existingStatuses) {
    if (SUCCEEDED_LINEAGE.includes(s)) {
      existingSucceededCount++;
    }
  }
  if (existingSucceededCount > 0) {
    return {
      ok: false,
      error: {
        kind: 'duplicate_succeeded_payment',
        existingSucceededCount,
      },
    };
  }
  return { ok: true };
}

/** Exported for test + repository filter reuse. */
export { SUCCEEDED_LINEAGE };
