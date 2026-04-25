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
import {
  getInvoiceForPayment as f4GetInvoiceForPayment,
  markPaidFromProcessor as f4MarkPaidFromProcessor,
  makeGetInvoiceDeps,
  type InvoiceForPayment as F4InvoiceForPayment,
  type GetInvoiceForPaymentError as F4GetInvoiceForPaymentError,
  type MarkPaidFromProcessorError as F4MarkPaidFromProcessorError,
} from '@/modules/invoicing';
import type {
  InvoicingBridgePort,
  InvoiceForPaymentDTO,
  GetInvoiceForPaymentBridgeError,
  MarkPaidFromProcessorInput,
} from '../application/ports/invoicing-bridge-port';

function mapF4InvoiceForPayment(
  v: F4InvoiceForPayment,
): InvoiceForPaymentDTO {
  return {
    id: v.id,
    status: v.status,
    totalSatang: v.totalSatang,
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
function summariseF4Error(e: F4MarkPaidFromProcessorError): {
  code: string;
  detail: string;
} {
  const shape = e as {
    code?: unknown;
    kind?: unknown;
    detail?: unknown;
    reason?: unknown;
  };
  const code =
    typeof shape.code === 'string'
      ? shape.code
      : typeof shape.kind === 'string'
        ? shape.kind
        : 'f4_error';
  const detail =
    typeof shape.detail === 'string'
      ? shape.detail
      : typeof shape.reason === 'string'
        ? shape.reason
        : `unknown_f4_error_shape (code=${code})`;
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
    });

    if (!f4Result.ok) {
      return err(summariseF4Error(f4Result.error));
    }
    return ok(undefined);
  },
};
