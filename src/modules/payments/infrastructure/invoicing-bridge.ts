/**
 * T066 — F5 → F4 Invoicing bridge adapter.
 *
 * Implements `InvoicingBridgePort` by calling F4's public barrel
 * (`@/modules/invoicing`) ONLY — no deep imports into F4
 * internals, no direct `drizzle-orm` imports. Composition stays
 * Clean-Architecture-pure per Constitution Principle III.
 *
 * --- D-03 atomicity (CLOSED in Group E2b, 2026-04-24) ------------
 *
 * F4's `markPaidFromProcessor` now accepts an optional `tx` parameter
 * (threaded into `makeRecordPaymentDeps(tenantId, tx?)` which builds a
 * tx-bound InvoiceRepo that short-circuits its `withTx` to inline
 * execution against the caller's tx). When F5's confirm-payment
 * wraps its writes in `paymentsRepo.withTx` and calls this bridge,
 * the tx is forwarded to F4 so the payment-row update and the
 * invoice `issued → paid` flip commit together. A rollback of F5's
 * outer tx now unwinds BOTH writes atomically (SC-013 invariant holds).
 */
import { err, ok, type Result } from '@/lib/result';
import { paymentsMetrics } from '@/lib/metrics';
import { asSatang } from '@/lib/money';
import {
  getInvoiceForPayment as f4GetInvoiceForPayment,
  markPaidFromProcessor as f4MarkPaidFromProcessor,
  issueCreditNoteFromRefund as f4IssueCreditNoteFromRefund,
  makeGetInvoiceDeps,
  type InvoiceForPayment as F4InvoiceForPayment,
  type GetInvoiceForPaymentError as F4GetInvoiceForPaymentError,
} from '@/modules/invoicing';
// Bridge response uses the public `CreditedInvoiceStatus` type — kept on
// the port file so the F5 caller derives the value without re-reading.
import type {
  InvoicingBridgePort,
  InvoiceForPaymentDTO,
  GetInvoiceForPaymentBridgeError,
  MarkPaidFromProcessorInput,
} from '../application/ports/invoicing-bridge-port';

function mapF4InvoiceForPayment(
  v: F4InvoiceForPayment,
): InvoiceForPaymentDTO {
  // F5R3v2 H-2 (2026-05-16) — defensive brand at F4→F5 boundary.
  // F4 + F5 both type money as `Satang` after the 2026-05-16
  // migration so this cast is structurally a no-op, BUT `asSatang`
  // still runtime-validates non-negative. If F4 ever surfaces a
  // negative total (data corruption, dropped CHECK constraint),
  // throwing here would mid-flight an `initiatePayment` call with
  // a generic 500 + no bridge-specific audit. Instead emit a
  // forensic counter + cap the totalSatang at zero so downstream
  // typed-error paths still fire (will hit the "invoice not
  // payable" branch with status=paid/credited rather than
  // mysteriously 500).
  let totalSatang: ReturnType<typeof asSatang>;
  try {
    totalSatang = asSatang(v.totalSatang);
  } catch {
    paymentsMetrics.f4BridgeUnknownErrorShape('f4_invoice_total_negative');
    totalSatang = asSatang(0n);
  }
  return {
    id: v.id,
    status: v.status,
    totalSatang,
    memberId: v.memberId,
    tenantId: v.tenantId,
  };
}

function mapF4GetError(
  e: F4GetInvoiceForPaymentError,
): GetInvoiceForPaymentBridgeError {
  switch (e.code) {
    case 'not_found':
      return { code: 'not_found' };
    case 'forbidden':
      return { code: 'forbidden' };
    case 'not_payable':
      return { code: 'not_payable', status: e.status };
  }
}

/**
 * Render an F4 error union into the stable `{ code, detail }`
 * shape. F4's discriminated errors are operational (audit + runbook)
 * rather than user-facing; F5 callers surface as a single
 * `f4_bridge_error` code.
 *
 * Audit 2026-04-25 finding #16: previous fallback `JSON.stringify(e)`
 * could leak F4-side PII (member email, invoice line text, etc.) into
 * F5's audit trail when an unfamiliar error variant flowed through.
 * We now whitelist scalar string fields on the discriminator + drop
 * everything else. If a future F4 error variant carries genuinely
 * useful structured detail, add a typed branch here rather than
 * widening the JSON.stringify fallback.
 */
/**
 * F5R1-TY13 — generic over the F4 error shape. Pre-fix the helper
 * accepted only `F4MarkPaidFromProcessorError` and forced the
 * issueCreditNoteFromRefund call site to `as unknown as
 * F4MarkPaidFromProcessorError` (double-cast) just to reuse the
 * duck-type. Now any structural shape with the optional
 * code/kind/detail/reason fields satisfies it — both bridge sites
 * pass through type-checked, and the unsafe cast is gone.
 */
function summariseF4Error<E extends {
  // F5R2-M4 — tightened from `unknown` → `string` (optional). The
  // `unknown` form let TS accept a caller passing `code: number`
  // even though the runtime guard then dropped it; the tighter
  // constraint catches that drift at compile time while keeping
  // the "at-least-one-of" flexibility (any optional string field
  // suffices). All F4 error variants today satisfy this constraint.
  readonly code?: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly reason?: string;
}>(e: E, bridgeOp: string): { code: string; detail: string } {
  const code =
    typeof e.code === 'string'
      ? e.code
      : typeof e.kind === 'string'
        ? e.kind
        : 'f4_error';
  const detail =
    typeof e.detail === 'string'
      ? e.detail
      : typeof e.reason === 'string'
        ? e.reason
        : `unknown_f4_error_shape (code=${code})`;
  // F5R2-SF-7 — bump dedicated counter when the unknown-shape fallback
  // fires so SRE can page on this specific class. Pre-fix the dispatcher
  // classified `'bridge_error'` as permanent → Stripe stops retrying →
  // customer's payment is `succeeded` but F4 invoice may still be
  // `issued`. Without the counter this silent data divergence was only
  // visible by manually correlating audit-summary text.
  //
  // F5R3 H-2 (2026-05-16) — ALSO bump when `code` itself fell through
  // to the generic `'f4_error'` literal (both `e.code` and `e.kind`
  // were absent / wrong shape). Pre-fix only the `detail`-fallback path
  // bumped the counter — a partial F4 error shape with `detail` present
  // but `code`+`kind` missing silently returned `code: 'f4_error'`. The
  // dispatcher's PERMANENT_SUB_USE_CASE_DETAILS set does NOT include
  // `'f4_error'`, so it classified as transient → Stripe 72h retry
  // storm on a permanently-malformed error shape. The two-path emit
  // closes both halves of the silent-misclassification window.
  if (
    detail.startsWith('unknown_f4_error_shape') ||
    code === 'f4_error'
  ) {
    paymentsMetrics.f4BridgeUnknownErrorShape(bridgeOp);
  }
  return { code, detail };
}

export const invoicingBridge: InvoicingBridgePort = {
  async getInvoiceForPayment(input) {
    const deps = makeGetInvoiceDeps(input.tenantId);
    const result = await f4GetInvoiceForPayment(deps, {
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      ...(input.actor ? { actor: input.actor } : {}),
    });
    if (!result.ok) return err(mapF4GetError(result.error));
    return ok(mapF4InvoiceForPayment(result.value));
  },

  async markPaidFromProcessor(
    input: MarkPaidFromProcessorInput,
    tx?: unknown,
  ): Promise<Result<void, { readonly code: string; readonly detail: string }>> {
    // D-03 closed (Group E2b): forward the caller's tx to F4 so the
    // payment-row + invoice-status writes commit atomically.
    const f4Result = await f4MarkPaidFromProcessor({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      ...(input.requestId != null ? { requestId: input.requestId } : {}),
      actorUserId: input.actorUserId,
      method: input.method,
      paymentIntentId: input.paymentIntentId,
      chargeId: input.chargeId,
      settlementDate: input.settlementDate,
      ...(tx !== undefined ? { tx } : {}),
      // T128a: forward F5 suppression flag to F4 record-payment.
      ...(input.suppressReceiptEmail !== undefined
        ? { suppressReceiptEmail: input.suppressReceiptEmail }
        : {}),
      // F8 hook: forward cross-module on-paid callbacks (e.g.
      // `f8OnPaidCallbacks(tenantId)` for renewal cycle completion) so
      // they fire inside F4's atomic tx alongside the invoice flip.
      ...(input.onPaidCallbacks !== undefined
        ? { onPaidCallbacks: input.onPaidCallbacks }
        : {}),
    });

    if (!f4Result.ok) {
      return err(summariseF4Error(f4Result.error, 'markPaidFromProcessor'));
    }
    return ok(undefined);
  },

  /**
   * T108 (Phase 6) — F5 → F4 credit-note bridge for the refund flow.
   *
   * Wraps F4's `issueCreditNoteFromRefund`. F4 owns the CN row,
   * sequence allocation, PDF render+upload, audit emission, outbox
   * enqueue, and the invoice status transition (→ `credited` or
   * `partially_credited`). The F5 caller `issueRefund` invokes this
   * OUTSIDE its own DB tx (Phase B/external) — F4 manages its own
   * atomicity via the wrapped use-case's internal `withTx`.
   *
   * Returns only the new CN id + canonical document number — the F5
   * caller derives the post-transition invoice status arithmetically
   * (`refundedAmount === payment.amountSatang` → `'credited'`),
   * avoiding a redundant DB roundtrip. F4 errors are summarised into
   * the stable `{ code, detail }` shape (no PII leak — see
   * `summariseF4Error` docstring).
   */
  async issueCreditNoteFromRefund(input) {
    const cn = await f4IssueCreditNoteFromRefund({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      refundId: input.refundId,
      amountSatang: input.amountSatang,
      reason: input.reason,
      actorUserId: input.actorUserId,
      ...(input.requestId !== null ? { requestId: input.requestId } : {}),
    });
    if (!cn.ok) {
      // Reuse the same scalar-only summariser used for
      // markPaidFromProcessor errors. F4's `IssueCreditNoteError` is
      // a discriminated union; the cast lets us share one helper.
      return err(summariseF4Error(cn.error, 'issueCreditNoteFromRefund'));
    }

    return ok({
      creditNoteId: cn.value.creditNoteId,
      creditNoteNumber: cn.value.documentNumber.raw,
    });
  },
};
