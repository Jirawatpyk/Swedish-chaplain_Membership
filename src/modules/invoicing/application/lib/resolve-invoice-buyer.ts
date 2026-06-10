/**
 * 064 — shared buyer resolution at issue time (issueInvoice bill-first +
 * issueEventInvoiceAsPaid). Matched member (`draft.memberId !== null`):
 * live re-read with FOR UPDATE (archive-race guard, FR-037) + snapshot
 * pinned now. Non-member (`draft.memberId === null`): the draft-pinned
 * snapshot (created by createEventInvoiceDraft) is the buyer.
 *
 * NOTE — the branch is keyed on `draft.memberId`, NOT on `invoiceSubject`:
 * the matched-member EVENT arm is the SAME code path as the F4 MEMBERSHIP
 * arm (a membership draft's buyer is always an F3 member; the `Invoice`
 * discriminated union + `invoices_subject_fields_ck` guarantee
 * `memberId` non-null for `invoice_subject='membership'`, so membership
 * drafts always take the live re-read arm and can never reach
 * `no_buyer_snapshot`). `issueInvoice` therefore routes ALL subjects
 * through this helper — keeping a separate inline membership copy would
 * duplicate the FR-037 archive-race guard, which is exactly the
 * copy-paste of tax-critical logic this extraction exists to avoid.
 */
import { err, ok, type Result } from '@/lib/result';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

export type ResolveInvoiceBuyerError =
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'no_buyer_snapshot' };

export async function resolveInvoiceBuyerForIssue(
  memberIdentity: MemberIdentityPort,
  tx: unknown,
  tenantId: string,
  draft: Invoice,
): Promise<Result<MemberIdentitySnapshot, ResolveInvoiceBuyerError>> {
  const memberId = draft.memberId;
  if (memberId !== null) {
    const member = await memberIdentity.getForIssue(
      tx,
      tenantId,
      memberId,
      { forUpdate: true },
    );
    if (!member) return err({ code: 'member_not_found' });
    if (member.isArchived) return err({ code: 'member_archived' });
    return ok(member.snapshot);
  }
  // Non-member event buyer — the snapshot was pinned at draft. Validate it
  // is present (data-integrity guard; the draft use-case always pins it).
  if (draft.memberIdentitySnapshot === null) {
    return err({ code: 'no_buyer_snapshot' });
  }
  return ok(draft.memberIdentitySnapshot);
}
