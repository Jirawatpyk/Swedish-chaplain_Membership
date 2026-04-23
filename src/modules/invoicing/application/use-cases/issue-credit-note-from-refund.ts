/**
 * T013 — issueCreditNoteFromRefund (F5 → F4 bridge).
 *
 * Wraps F4's `issueCreditNote` use-case so the F5 refund success path
 * can materialise a credit note against the original invoice + persist
 * the F5 refund id via `credit_notes.source_refund_id` (migration 0038).
 *
 * The F4 use-case owns: row-lock on the invoice, remainder-credit
 * invariant guard, PDF render + Blob upload, audit, annotation re-
 * stamp, status transition to `credited` / `partially_credited`, email
 * outbox enqueue, sequence allocation. The wrapper adds only:
 *
 *   1. Processor-semantic input shape — F5 caller supplies the
 *      `refundId` + satang amount + human-readable reason drawn from
 *      the F5 refund row.
 *   2. F4 extension wiring — threads `sourceRefundId` through the F4
 *      input schema + repo insert so the CN row's new column points
 *      back at the F5 refund.
 *   3. Error-shape passthrough — F4's `IssueCreditNoteError` returned
 *      verbatim. F5 callers branch on the same discriminated union;
 *      no new error codes at the bridge.
 *
 * Composition — per Main-agent Gate Decision #6: wrappers MUST compose
 * real F4 deps, never mock/bypass. We call `makeIssueCreditNoteDeps`
 * at invocation time to get the full graph (PDF + Blob + audit +
 * outbox + sequence allocator), then delegate.
 *
 * Actor identity: F5 refund admin-initiated — pass through the real
 * admin user id. Webhook-side refund resolution (if ever used) must
 * supply `'system:stripe-webhook'` as the sentinel, mirroring the
 * `markPaidFromProcessor` convention.
 *
 * Amount semantics: the caller supplies the F5 refund satang amount.
 * F4 `creditTotalSatang` expects the gross refund total (incl. VAT),
 * which matches Stripe's refund amount semantics. F4 internally splits
 * gross → vat + net via its credit-note-vat policy.
 */
import { type Result } from '@/lib/result';
import {
  issueCreditNote,
  type IssueCreditNoteError,
} from './issue-credit-note';
import { makeIssueCreditNoteDeps } from '../invoicing-deps';
import type { CreditNote } from '@/modules/invoicing/domain/credit-note';

export interface IssueCreditNoteFromRefundInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** F5 refund row id — populates `credit_notes.source_refund_id`. */
  readonly refundId: string;
  /** Gross satang amount (incl. VAT) — matches F5 refund row. */
  readonly amountSatang: bigint;
  /** Free-form reason — surfaces as the CN's `reason` column + PDF body. */
  readonly reason: string;
  readonly actorUserId: string;
  readonly requestId?: string | null;
}

/**
 * Output mirrors F4's `CreditNote` for readiness composition — F5
 * callers can surface it in the refund-success response (admin UI
 * shows the new CN's document number immediately without a second
 * DB roundtrip).
 */
export type IssueCreditNoteFromRefundOutput = CreditNote;

/**
 * Error union re-exports F4's so F5 consumers match on the same
 * discriminated shape. No bridge-only error codes — every failure
 * mode lives in F4's domain vocabulary.
 */
export type IssueCreditNoteFromRefundError = IssueCreditNoteError;

export async function issueCreditNoteFromRefund(
  input: IssueCreditNoteFromRefundInput,
): Promise<
  Result<IssueCreditNoteFromRefundOutput, IssueCreditNoteFromRefundError>
> {
  const deps = makeIssueCreditNoteDeps(input.tenantId);
  return issueCreditNote(deps, {
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    invoiceId: input.invoiceId,
    creditTotalSatang: input.amountSatang,
    reason: input.reason,
    // F5 bridge wiring — this is the ONLY behavioural delta vs. F4-
    // manual issue. The F4 repo persists `source_refund_id` verbatim
    // via the barrel-extended insertCreditNote port.
    sourceRefundId: input.refundId,
  });
}
