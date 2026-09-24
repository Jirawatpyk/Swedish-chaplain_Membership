/**
 * 0306 — read facade: recent MANUAL credit notes (no `source_refund_id`)
 * whose staff chose "End membership" (`credit_notes.membership_effect =
 * 'cancel_membership'`, written in the credit note's own tx).
 *
 * The renewals reconcile uses it as a BACKSTOP for the credit-note route's
 * post-commit "end membership" call (lost if the function dies in between).
 * Refund-origin credit notes are excluded — the F5 refund row is their
 * source of truth.
 *
 * Read-only, tenant-scoped. Pure Application — its own port, no ORM imports.
 */
import { err, ok, type Result } from '@/lib/result';

export interface ManualCreditNoteEndingMembershipRow {
  readonly creditNoteId: string;
  readonly invoiceId: string;
  readonly memberId: string;
  readonly issuedAt: Date;
}

export interface ListManualCreditNotesEndingMembershipDeps {
  readonly read: (
    tenantId: string,
    since: Date,
  ) => Promise<readonly ManualCreditNoteEndingMembershipRow[]>;
}

export async function listManualCreditNotesEndingMembership(
  deps: ListManualCreditNotesEndingMembershipDeps,
  input: { readonly tenantId: string; readonly since: Date },
): Promise<
  Result<readonly ManualCreditNoteEndingMembershipRow[], { readonly code: 'read_failed' }>
> {
  try {
    return ok(await deps.read(input.tenantId, input.since));
  } catch {
    return err({ code: 'read_failed' });
  }
}
