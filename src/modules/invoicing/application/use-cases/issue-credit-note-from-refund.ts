/**
 * T013 — issueCreditNoteFromRefund (F5 → F4 bridge).
 *
 * ⚠ **STUB — real implementation deferred to Phase 2 sub-batch B**.
 *
 * Reason: the wrapper must populate `credit_notes.source_refund_id`,
 * which is added by migration `0037_credit_notes_add_source_refund_id.sql`
 * (T024). That migration + the F4 schema + `issueCreditNote` use-case
 * input extension land in sub-batch B. Until then, calling this
 * wrapper throws a clear error so mis-wired call sites surface at
 * runtime rather than silently skipping the refund → CN side-effect.
 *
 * The public contract is stable: `{ tenantId, invoiceId, refundId,
 * amountSatang, reason, actorUserId, requestId }` in → `Result<CreditNote,
 * error>` out. Sub-batch B will:
 *
 *   1. Apply migration 0037 (new nullable FK column + partial index)
 *   2. Extend F4 `creditNotes` Drizzle schema with the new column
 *   3. Extend `issueCreditNoteSchema` + `IssueCreditNoteInput` with
 *      optional `sourceRefundId` param
 *   4. Extend `drizzle-credit-note-repo` insert to persist it
 *   5. Replace this stub body with a composition of
 *      `makeIssueCreditNoteDeps(tenantId)` + `issueCreditNote(deps, …)`
 *      passing `sourceRefundId`, a single line {description = reason,
 *      amount = refundAmount}, and the standard audit payload.
 *
 * The function is exported and typechecks today so:
 *   - T010 barrel can include the name
 *   - T011 surface test passes
 *   - F5 US4 refund path code can be written against the stable
 *     signature concurrently with sub-batch B
 */
import { err, type Result } from '@/lib/result';

export interface IssueCreditNoteFromRefundInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** F5 refund row id — populates `credit_notes.source_refund_id`. */
  readonly refundId: string;
  /** Satang amount — MUST equal the refund row's `amount_satang`. */
  readonly amountSatang: bigint;
  /** Free-form reason — surfaces as the CN's single-line description. */
  readonly reason: string;
  readonly actorUserId: string;
  readonly requestId?: string | null;
}

/**
 * Error union mirrors F4's `IssueCreditNoteError` plus a bridge-only
 * `not_implemented` code emitted by the stub. The shape is stable —
 * sub-batch B replaces the body only; the type does not change.
 */
export type IssueCreditNoteFromRefundError =
  | { code: 'not_implemented'; reason: string };

/**
 * Result placeholder. Sub-batch B replaces this with the real
 * `CreditNote` domain type re-exported from F4.
 */
export interface IssueCreditNoteFromRefundOutput {
  readonly creditNoteId: string;
  readonly invoiceId: string;
  readonly sourceRefundId: string;
  readonly amountSatang: bigint;
}

export async function issueCreditNoteFromRefund(
  input: IssueCreditNoteFromRefundInput,
): Promise<
  Result<IssueCreditNoteFromRefundOutput, IssueCreditNoteFromRefundError>
> {
  // Intentional side-effect: touch the input shape in the error
  // message so the caller knows EXACTLY which refund was rejected by
  // the stub. Replaced in sub-batch B with the real composition.
  return err({
    code: 'not_implemented',
    reason:
      `F5 → F4 credit-note-from-refund bridge is a stub pending migration 0037 ` +
      `(credit_notes.source_refund_id) + F4 issueCreditNote schema extension. ` +
      `Attempted: refund ${input.refundId} on invoice ${input.invoiceId} ` +
      `(tenant ${input.tenantId}). See JSDoc for sub-batch B rewire plan.`,
  });
}
