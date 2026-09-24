/**
 * 0306 — `MembershipEndRequestSource` adapter: composes the payments +
 * invoicing public barrels (Principle III — no reach into F4/F5 internals) to
 * list recent staff "End membership" decisions from their durable rows.
 *
 * A failed read on one side THROWS — the reconcile's backstop step catches it,
 * counts it `errored`, and still runs its other steps (a silent empty list
 * would hide a lost decision).
 */
import {
  listRefundsEndingMembership,
  makeListRefundsEndingMembershipDeps,
} from '@/modules/payments';
import {
  listManualCreditNotesEndingMembership,
  makeListManualCreditNotesEndingMembershipDeps,
} from '@/modules/invoicing';
import type {
  MembershipEndRequestRecord,
  MembershipEndRequestSource,
} from '../../application/ports/membership-end-request-source';

export const membershipEndRequestSource: MembershipEndRequestSource = {
  async listSince(tenantId, sinceIso) {
    const since = new Date(sinceIso);
    const [refundsResult, creditNotesResult] = await Promise.all([
      listRefundsEndingMembership(makeListRefundsEndingMembershipDeps(tenantId), {
        tenantId,
        since,
      }),
      listManualCreditNotesEndingMembership(
        makeListManualCreditNotesEndingMembershipDeps(tenantId),
        { tenantId, since },
      ),
    ]);
    if (!refundsResult.ok) throw new Error('membership-end source: refunds read failed');
    if (!creditNotesResult.ok) {
      throw new Error('membership-end source: credit notes read failed');
    }
    const records: MembershipEndRequestRecord[] = [
      ...refundsResult.value.map(
        (r): MembershipEndRequestRecord => ({
          kind: 'refund',
          refundId: r.refundId,
          invoiceId: r.invoiceId,
          memberId: r.memberId,
          refundStatus: r.status,
          at: r.initiatedAt.toISOString(),
        }),
      ),
      ...creditNotesResult.value.map(
        (c): MembershipEndRequestRecord => ({
          kind: 'credit_note',
          creditNoteId: c.creditNoteId,
          invoiceId: c.invoiceId,
          memberId: c.memberId,
          at: c.issuedAt.toISOString(),
        }),
      ),
    ];
    return records;
  },
};
