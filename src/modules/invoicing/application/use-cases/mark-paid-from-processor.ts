/**
 * T012 — markPaidFromProcessor (F5 → F4 bridge).
 *
 * Wraps F4's `recordPayment` use-case so the F5 webhook handler can
 * transition an `issued → paid` invoice when Stripe reports success.
 * The F4 use-case already owns: row-lock, idempotent replay, receipt
 * sequence allocation (separate-mode), PDF render + upload, audit,
 * outbox enqueue, registration-fee flip. The wrapper adds only:
 *
 *   1. Processor-semantic input shape (`method`, `paymentIntentId`,
 *      `chargeId`, `settlementDate`) — the F5 webhook supplies these
 *      directly from the Stripe event payload.
 *   2. F4 enum mapping — F4's `invoices.payment_method` enum does NOT
 *      include Stripe methods; the wrapper persists `'other'` and
 *      encodes the processor hint in `paymentNotes`. The canonical
 *      processor ids + method live in the `payments` table (F5 schema,
 *      migration 0032); F4 invoice only carries the summary hint so
 *      the admin detail page can label "Paid online (Stripe card)".
 *   3. Error-shape passthrough — F4's `RecordPaymentError` is returned
 *      verbatim. F5 callers match on the same discriminated union;
 *      no new error codes are introduced at the bridge.
 *
 * Actor identity: webhook-side calls do not have a human actor. The
 * caller MUST pass `SYSTEM_ACTOR_STRIPE_WEBHOOK` (from the payments
 * barrel) — a reserved UUID seeded into the `users` table by migration
 * 0041. This keeps every `uuid REFERENCES users(id)` FK intact
 * (payments.actor_user_id, invoices.payment_recorded_by_user_id,
 * audit_log.actor_user_id) without requiring schema-wide changes.
 * For F5-admin-initiated manual reconciliation paths (rare — primarily
 * `payment_auto_refunded_*` remediation), callers supply the real
 * admin user id.
 *
 * Composition: the wrapper calls `makeRecordPaymentDeps(tenantId, tx?)`
 * at call time — per Main-agent Gate Decision #6 wrappers MUST compose
 * real F4 deps and never mock/bypass (Constitution Principle III +
 * Principle VIII reliability). When the caller supplies `tx`, the
 * underlying invoice-repo short-circuits its own `withTx` to reuse that
 * tx so the F5 payment-row update and the F4 invoice flip to `paid`
 * commit in a SINGLE transaction (Reliability D-03, Group E2b).
 *
 * Tenant context: input accepts the plain `tenantId` string (not a
 * branded `TenantContext`) to match F4's existing pattern + spare
 * F5 callers from threading two separate representations. The caller
 * (webhook handler) has already run the request through `runInTenant`
 * by the time this wrapper fires.
 */
import { type Result } from '@/lib/result';
import {
  recordPayment,
  type RecordPaymentError,
} from './record-payment';
import { makeRecordPaymentDeps } from '../invoicing-deps';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import type { F4InvoicePaidEvent } from '@/modules/invoicing/domain/f4-invoice-paid-event';

/** F5-surface payment-method discriminator. Widen as new rails land. */
export type ProcessorPaymentMethod = 'stripe_card' | 'stripe_promptpay';

export interface MarkPaidFromProcessorInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /**
   * Stable correlation id for the webhook delivery — carried into
   * audit payloads + logger context so we can trace the full chain
   * from Stripe event → F4 markPaid → outbox enqueue.
   */
  readonly requestId?: string | null;
  /**
   * Actor identifier. Webhook-side invocations use the sentinel
   * `'system:stripe-webhook'`; admin remediation paths pass the real
   * user id. F4 `recordPayment` expects a non-empty string.
   */
  readonly actorUserId: string;
  readonly method: ProcessorPaymentMethod;
  /** Stripe Payment Intent id (`pi_*`). Not sensitive per Stripe docs. */
  readonly paymentIntentId: string;
  /**
   * Stripe Charge id (`ch_*`) of the succeeded charge. Nullable
   * because PromptPay async confirmation can land before a charge
   * is finalised under some edge flows; the F5 reconciliation layer
   * backfills once the charge id is known.
   */
  readonly chargeId: string | null;
  /**
   * Settlement / charge date as YYYY-MM-DD in Asia/Bangkok local
   * calendar — F4's `paymentDate` column stores the admin-facing
   * bookkeeping date and expects this shape. Webhook handler
   * converts the Stripe event's UTC ts before calling.
   */
  readonly settlementDate: string;
  /**
   * Optional caller-owned Drizzle tx handle. When supplied, F4's
   * invoice-repo reuses this tx (no nested `withTx`) so the F5 payment
   * row update and the F4 invoice `issued → paid` flip commit together.
   * Closes Reliability D-03 (Group E2b). Callers that supply `tx` MUST
   * already be inside a `runInTenant` session for the same tenant so
   * `SET LOCAL app.current_tenant` is in effect.
   */
  readonly tx?: unknown;
  /**
   * T128a (2026-04-27): when `true`, F4's `recordPayment` skips the
   * auto-email outbox enqueue. Set by F5 `confirmPayment` when the
   * tenant's `tenant_payment_settings.auto_email_on_payment = false`.
   * Status flip, audit, PDF render, and registration-fee flip all
   * still run — only the dispatcher enqueue is gated. Spec.md:433
   * "MAY suppress" optional override.
   */
  readonly suppressReceiptEmail?: boolean;
  /**
   * F8 Phase 2 Wave A (T008) — cross-module on-paid hooks forwarded
   * verbatim to `makeRecordPaymentDeps`. F8's `complete-cycle-on-paid`
   * adapter is registered here at the F5 webhook composition root so
   * the renewal cycle transition lands inside the same atomic tx as
   * the F4 invoice `issued → paid` flip (Complexity Tracking #3 +
   * research.md R12). Any callback rejection rolls back the entire
   * webhook tx including the F4 flip — no compensating action needed.
   */
  readonly onPaidCallbacks?: ReadonlyArray<(evt: F4InvoicePaidEvent) => Promise<void>>;
}

export type MarkPaidFromProcessorError = RecordPaymentError;

/**
 * Map F5 `ProcessorPaymentMethod` into a human-readable F4
 * `paymentNotes` hint. Kept as a pure function so the wrapper is
 * easily unit-testable; localisation is NOT applied here — notes
 * are admin-facing English only (F4 convention).
 */
function describeProcessorMethod(
  method: ProcessorPaymentMethod,
  paymentIntentId: string,
  chargeId: string | null,
): string {
  let rail: string;
  switch (method) {
    case 'stripe_card':
      rail = 'Stripe card';
      break;
    case 'stripe_promptpay':
      rail = 'Stripe PromptPay';
      break;
  }
  const ids = chargeId
    ? `intent=${paymentIntentId} charge=${chargeId}`
    : `intent=${paymentIntentId}`;
  return `Paid online via ${rail} (${ids})`;
}

export async function markPaidFromProcessor(
  input: MarkPaidFromProcessorInput,
): Promise<Result<Invoice, MarkPaidFromProcessorError>> {
  const deps = makeRecordPaymentDeps(
    input.tenantId,
    input.tx,
    input.onPaidCallbacks,
  );
  return recordPayment(deps, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    ...(input.requestId != null ? { requestId: input.requestId } : {}),
    invoiceId: input.invoiceId,
    // F4 enum does not include Stripe rails; persist `'other'` + carry
    // the rail hint in notes. F5 `payments` row is the source of truth
    // for the exact processor method + ids.
    paymentMethod: 'other',
    paymentNotes: describeProcessorMethod(
      input.method,
      input.paymentIntentId,
      input.chargeId,
    ),
    paymentReference: input.paymentIntentId,
    paymentDate: input.settlementDate,
    ...(input.suppressReceiptEmail !== undefined
      ? { suppressReceiptEmail: input.suppressReceiptEmail }
      : {}),
    // F8 Phase 2 Wave A — surface the F5 rail + webhook origin to
    // `onPaidCallbacks` listeners (event shape per research.md R12).
    // The wrapper is webhook-only by current contract; F5 admin
    // reconciliation paths that go through this wrapper still set
    // `'webhook'` because the trigger semantically means "Stripe
    // webhook event was acked", not "automated vs human action".
    processorMethod: input.method,
    triggeredBy: 'webhook',
  });
}
