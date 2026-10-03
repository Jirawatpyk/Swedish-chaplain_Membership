/**
 * Spec 122 US8b follow-up — preview the §86/10 ใบลดหนี้ a refund of
 * `creditTotalSatang` would issue, for the refund dialog's "Credit note to be
 * issued" rows (boards `Admin-refund-full`, `Admin-refund-partial`).
 *
 * READ-ONLY. Nothing here allocates or writes; the only audit is the
 * cross-tenant probe `getInvoice` emits when an `actor` is supplied and the
 * invoice is not in the tenant. The answer is built
 * from the SAME pieces the money path uses, so the dialog cannot show a split
 * the refund will not issue:
 *
 *   1. The verdict — `resolveRefundCreditNoteRequirement`, fed exactly as the
 *      F5 refund pre-flight feeds it (`payments/infrastructure/invoicing-
 *      bridge.ts` → `getInvoiceCreditedTotal`): `isSection105` through the
 *      shared `inferEventDocumentKind ∘ resolveBuyerIsVatRegistrant`
 *      composition, never re-derived from TIN presence. A `waive` (a §105
 *      receipt, a voided invoice) owes no credit note, so no VAT is shown; a
 *      `blocked` gate refuses the refund, so none is shown either.
 *   2. The split — `enforceCreditCannotExceedRemainder` then
 *      `calculateCreditNoteVat` on the invoice's snapshotted VAT and total,
 *      steps D and E of `issue-credit-note.ts`. Each note is rounded on its
 *      own; there is no residual rule for the last partial, so none here.
 *
 * IF EITHER OF THOSE CHANGES, THIS CHANGES WITH IT.
 *
 * Not mirrored, exactly as the refund pre-flight does not mirror them:
 * `issue-credit-note.ts`'s corrupt-row and config gates (missing snapshot
 * fields, tenant settings, event-invoice linkage, membership effect). On such
 * a row the preview shows a split while the refund's credit note is deferred
 * — a data fault, not a money one, and the issued note never differs in
 * amount from what was shown.
 */
import { ok, err, type Result } from '@/lib/result';
import { getInvoice, type GetInvoiceDeps, type GetInvoiceInput } from './get-invoice';
import { calculateCreditNoteVat } from '@/modules/invoicing/domain/policies/calculate-credit-note-vat';
import { enforceCreditCannotExceedRemainder } from '@/modules/invoicing/domain/policies/enforce-credit-cannot-exceed-remainder';
import {
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
} from '@/modules/invoicing/domain/document-kind';
import {
  resolveRefundCreditNoteRequirement,
  type CreditNoteWaiverReason,
} from '@/modules/invoicing/domain/refund-credit-note-requirement';
import { Money } from '@/modules/invoicing/domain/value-objects/money';

export interface PreviewRefundCreditNoteInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  /** The refund amount — the credit note's gross total (incl. VAT). */
  readonly creditTotalSatang: bigint;
  /**
   * The staff member asking. When present, an invoice id outside the tenant
   * emits `invoice_cross_tenant_probe` (Principle I clause 3), as the detail
   * page does.
   */
  readonly actor?: GetInvoiceInput['actor'];
}

export type RefundCreditNotePreview =
  | {
      readonly kind: 'issue';
      /** Credit-note amount excluding VAT. */
      readonly netSatang: bigint;
      readonly vatSatang: bigint;
      /** The invoice's snapshotted rate, `x.xxxx` (e.g. `0.0700`). */
      readonly vatRateRaw: string;
    }
  | { readonly kind: 'waived'; readonly reason: CreditNoteWaiverReason }
  | { readonly kind: 'blocked' };

export type PreviewRefundCreditNoteError =
  | { readonly code: 'not_found' }
  | { readonly code: 'exceeds_remainder'; readonly remainingSatang: bigint }
  | { readonly code: 'invoice_data_corrupt' };

export async function previewRefundCreditNote(
  deps: GetInvoiceDeps,
  input: PreviewRefundCreditNoteInput,
): Promise<Result<RefundCreditNotePreview, PreviewRefundCreditNoteError>> {
  // RLS + the tenant-scoped repo make another tenant's invoice a not-found;
  // with an `actor`, `getInvoice` also audits the probe.
  const found = await getInvoice(deps, {
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  });
  if (!found.ok) return err({ code: 'not_found' });
  const inv = found.value;

  const requirement = resolveRefundCreditNoteRequirement({
    status: inv.status,
    isSection105:
      inferEventDocumentKind(
        inv.invoiceSubject,
        resolveBuyerIsVatRegistrant(inv.memberId, inv.memberIdentitySnapshot),
      ) === 'receipt_separate',
    hasIdentitySnapshot: inv.memberIdentitySnapshot != null,
    receiptPdfStatus: inv.receiptPdfStatus,
  });

  switch (requirement.kind) {
    case 'waive':
      return ok({ kind: 'waived', reason: requirement.reason });
    case 'blocked':
      return ok({ kind: 'blocked' });
    case 'issue':
      break;
    default: {
      // Fail closed: an unknown verdict shows no credit note rather than a
      // split nobody issues (CLAUDE.md — never `return _exhaustive`).
      const _exhaustive: never = requirement;
      void _exhaustive;
      return ok({ kind: 'blocked' });
    }
  }

  // An issuable invoice always carries its money snapshot; a missing one is a
  // corrupt row, never a zero split.
  if (!inv.vat || !inv.total || !inv.vatRate) {
    return err({ code: 'invoice_data_corrupt' });
  }

  const proposed = Money.fromSatangUnsafe(input.creditTotalSatang);
  const remainder = enforceCreditCannotExceedRemainder({
    invoiceTotal: inv.total,
    alreadyCredited: inv.creditedTotal,
    proposed,
  });
  if (!remainder.ok) {
    // Already clamped at 0 by the policy.
    return err({ code: 'exceeds_remainder', remainingSatang: remainder.error.remainingSatang });
  }

  const split = calculateCreditNoteVat({
    creditTotal: proposed,
    originalVat: inv.vat,
    originalTotal: inv.total,
  });
  if (!split.ok) return err({ code: 'invoice_data_corrupt' });

  return ok({
    kind: 'issue',
    netSatang: split.value.creditAmount.satang,
    vatSatang: split.value.vat.satang,
    vatRateRaw: inv.vatRate.raw,
  });
}
