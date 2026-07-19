/**
 * Money-remediation Task 9 (F-9) — recognise a refund the APP initiated, by a
 * key that exists BEFORE the external call.
 *
 * THE DEFECT. `issueRefund` inserts the `refunds` row, calls Stripe, and only
 * THEN writes `processor_refund_id` in a separate tx. A `charge.refunded` /
 * `refund.updated` delivery that lands inside that window looks the refund up
 * by `processor_refund_id`, finds nothing, and fires
 * `out_of_band_refund_detected` — a 10-year forensic asserting money left by an
 * unauthorised route, plus an on-call page, for a refund we initiated
 * ourselves. The durable variant is worse: `attachProcessorRefundId` throws on
 * zero rows and has no try/catch, so a Neon blip or function timeout strands
 * the row NULL forever and EVERY delivery in Stripe's ~3-day retry series
 * re-fires the false forensic.
 *
 * Beyond the noise, this is signal pollution of the kind that gets a real
 * incident dismissed: on the day someone DOES issue an unauthorised Dashboard
 * refund, an alert that cries wolf on ordinary refunds is triaged away. And it
 * leaves auditors reconciling §86/10 with a 10-year record of an event that
 * never happened.
 *
 * WHY THIS SHAPE. `issueRefund` already stamps `metadata.refundId` on the
 * Stripe Refund BEFORE `createRefund` (`issue-refund.ts:629`), so the marker
 * exists exactly when `processor_refund_id` does not. This mirrors the durable
 * auto-refund marker (`payments.auto_refund_processor_refund_id`, stamped in
 * the same tx as the decision) that the sibling suppression path already
 * consults — same problem, same shape, different key.
 *
 * OVER-SUPPRESSION IS THE DANGEROUS DIRECTION. This alert exists to catch money
 * leaving by an unauthorised route, and the marker is set by the party being
 * watched: anyone with Stripe Dashboard access can put `metadata.refundId` on a
 * hand-made refund and try to mute their own alarm. Recognition therefore
 * requires ALL FOUR mitigations, and every one of them is mandatory:
 *
 *   1. `parseRefundId` validation at the verifier (trust perimeter) — the
 *      marker never reaches here unvalidated.
 *   2. `processor_refund_id IS NULL` in the repo — structurally incapable of
 *      addressing an already-matched row.
 *   3. an explicit tenant filter on the lookup, on top of RLS.
 *   4. the PaymentIntent cross-check below.
 *
 * EVERY non-recognition outcome falls through to the forensic. A marker that
 * names a row under a different PaymentIntent is NOT a benign miss — it is
 * forged or corrupted, and it is exactly what a hostile actor produces, so it
 * must keep its 10-year record.
 *
 * IT DOES NOT FINALISE. On recognition this back-fills `processor_refund_id`
 * and stops. It does not book a credit note, flip the refund, or touch the
 * parent payment: settlement ownership stays with `charge.refund.updated` /
 * `refund.updated` (A.11/A.12). The back-fill alone is what makes the row
 * reconcilable again — the next delivery matches it by `processor_refund_id`
 * through the ordinary path, and the stale-pending sweep, which SKIPS rows with
 * a NULL processor id, can finally see it.
 *
 * Pure Application — no framework / ORM imports.
 */
import type { LoggerPort, RefundsRepo } from '../ports';

export interface RecogniseAppInitiatedRefundDeps {
  readonly refundsRepo: RefundsRepo;
  readonly logger?: LoggerPort;
}

export interface RecogniseAppInitiatedRefundInput {
  readonly tenantId: string;
  /**
   * The app marker for THIS Stripe refund (`metadata.refundId`), already
   * format-validated by the verifier. `undefined` when the refund carries no
   * marker — the normal shape of a genuine Stripe-Dashboard refund.
   */
  readonly appRefundId: string | undefined;
  /** Stripe refund id (`re_…`) to back-fill onto the row. */
  readonly processorRefundId: string;
  /**
   * PaymentIntent id from the event. `null`/`undefined` means the verifier
   * could not extract one, so the cross-check is UNSATISFIABLE — and an
   * unsatisfiable check must NOT suppress.
   */
  readonly paymentIntentId: string | null | undefined;
}

export type AppInitiatedRefundRecognition =
  /** Recognised + back-filled. Caller suppresses the forensic. */
  | {
      readonly kind: 'recognised';
      readonly refundId: string;
      readonly invoiceId: string;
      readonly paymentId: string;
    }
  /** No marker — an ordinary Dashboard refund. Caller emits the forensic. */
  | { readonly kind: 'no_marker' }
  /** Marker present but resolved nothing. Caller emits the forensic. */
  | { readonly kind: 'unresolved' }
  /** Marker resolved a row under a DIFFERENT PI, or the PI is unknown. */
  | { readonly kind: 'payment_intent_mismatch' }
  /** Marker resolved a TERMINAL row — contradicts its own rejection proof. */
  | { readonly kind: 'not_pending'; readonly status: string };

export async function recogniseAppInitiatedRefund(
  deps: RecogniseAppInitiatedRefundDeps,
  tx: unknown,
  input: RecogniseAppInitiatedRefundInput,
): Promise<AppInitiatedRefundRecognition> {
  if (input.appRefundId === undefined) return { kind: 'no_marker' };

  // Mitigations 2 + 3 live in the repo: `processor_refund_id IS NULL` plus an
  // explicit tenant filter over RLS. A forged marker naming another tenant's
  // row resolves to null here and falls through to the forensic — which is the
  // correct outcome for a cross-tenant probe (Principle I).
  const awaiting = await deps.refundsRepo.findAwaitingAttachByAppRefundId(
    tx,
    input.tenantId,
    input.appRefundId,
  );
  if (awaiting === null) {
    // Deliberately NOT logged at warn. This is the common shape of a benign
    // race the fix itself creates: `issueRefund` won and attached the id
    // microseconds before this webhook ran, so the row is no longer "awaiting".
    // The caller's own lookup by `processor_refund_id` already matched it in
    // that case; warning here would page on a healthy path.
    return { kind: 'unresolved' };
  }

  // Mitigation 4 — anti-forgery. An attacker refunding their own charge cannot
  // make it belong to someone else's PaymentIntent, so a marker pointing at a
  // row under a different PI is forged or corrupted. `null`/absent PI means we
  // could not check, and an unsatisfiable check must not suppress.
  if (
    input.paymentIntentId === null ||
    input.paymentIntentId === undefined ||
    awaiting.parentProcessorPaymentIntentId !== input.paymentIntentId
  ) {
    // WARN, unlike the branch above: this is either a forgery attempt or real
    // data corruption, and the caller is about to emit the forensic anyway.
    // PCI SAQ-A + PDPA: opaque ids only.
    deps.logger?.warn('refund_marker_payment_intent_mismatch', {
      tenantId: input.tenantId,
      refundId: awaiting.id,
      processorRefundId: input.processorRefundId,
      eventPaymentIntentId: input.paymentIntentId ?? null,
      rowPaymentIntentId: awaiting.parentProcessorPaymentIntentId,
    });
    return { kind: 'payment_intent_mismatch' };
  }

  // A NULL `processor_refund_id` on a TERMINAL row means the refund was
  // finalised under a rejection proof — Stripe told us the money never moved.
  // A settlement webhook now naming that row is a genuine contradiction, so it
  // keeps its forensic instead of being quietly back-filled into looking
  // healthy. (Not filtered in SQL: the caller must be able to see this case.)
  if (awaiting.status !== 'pending') {
    deps.logger?.warn('refund_marker_matched_terminal_row', {
      tenantId: input.tenantId,
      refundId: awaiting.id,
      processorRefundId: input.processorRefundId,
      rowStatus: awaiting.status,
    });
    return { kind: 'not_pending', status: awaiting.status };
  }

  // Back-fill. Runs in the caller's dispatch tx, so it commits atomically with
  // `markProcessed` — a rollback re-opens the whole window rather than leaving
  // a half-recognised row.
  //
  // `attachProcessorRefundId` has no `IS NULL` predicate, so a concurrent
  // `issueRefund` Phase B that committed between our read and this write would
  // be overwritten. That is benign: the idempotency key is stable per logical
  // attempt (Task 6), so Stripe returns ONE refund id and both writers write
  // the SAME value.
  await deps.refundsRepo.attachProcessorRefundId(tx, {
    refundId: awaiting.id,
    tenantId: input.tenantId,
    processorRefundId: input.processorRefundId,
  });

  return {
    kind: 'recognised',
    refundId: awaiting.id,
    invoiceId: awaiting.invoiceId,
    paymentId: awaiting.paymentId,
  };
}
