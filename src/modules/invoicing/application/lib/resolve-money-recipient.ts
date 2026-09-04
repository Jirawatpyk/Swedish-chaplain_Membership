/**
 * 108 FR-001/FR-002/FR-003 — who a money email is addressed to.
 *
 * Two different questions live on an invoice and this module keeps them apart:
 *
 *   • WHO WAS BILLED — frozen at issue in `MemberIdentitySnapshot` (F4 FR-038).
 *     Thai Revenue Code §86/4 requires the tax document to keep naming the buyer
 *     as they were when the document was issued. That never moves.
 *   • WHERE THE EMAIL GOES — resolved LIVE, here, at enqueue time. A receipt,
 *     void notice, credit note or resend produced after the member promoted a
 *     new primary contact must reach whoever is primary NOW; the person who
 *     left the organisation must not keep receiving its invoices.
 *
 * Reading the snapshot for delivery conflates the two (the bug this closes:
 * every F4 auto-email addressed `member_identity_snapshot.primary_contact_email`,
 * so promote-after-issue kept mailing the former contact forever).
 *
 * A non-member event buyer is the one case where the snapshot IS the delivery
 * address: an admin typed it at issue and there is no contact row to read. That
 * single read is the reason this file is allow-listed in
 * `scripts/check-money-email-recipient.ts`.
 *
 * There is deliberately NO fallback: `no_recipient` means the caller skips the
 * email (and audits the skip) rather than guessing an address.
 */
import type { RecipientLocalePort } from '../ports/recipient-locale-port';
import type { F4OutboxLocale } from '../ports/email-outbox-port';

export type MoneyRecipient =
  /** Live primary contact of a member invoice. */
  | { readonly kind: 'member'; readonly email: string; readonly locale: F4OutboxLocale | null }
  /** Non-member event buyer — the address an admin typed at issue. */
  | { readonly kind: 'non_member'; readonly email: string }
  /** No deliverable address: skip the email, audit the skip, never fall back. */
  | { readonly kind: 'no_recipient' };

/**
 * The buyer-identity snapshot, narrowed to the only field this module may read.
 * Structural on purpose so callers can pass a `MemberIdentitySnapshot` (whose
 * `primary_contact_email` is non-nullable) or a legacy/absent one.
 */
export interface MoneyRecipientSnapshot {
  readonly primary_contact_email?: string | null;
}

export async function resolveMoneyRecipient(
  port: RecipientLocalePort,
  tx: unknown,
  tenantId: string,
  memberId: string | null,
  snapshot: MoneyRecipientSnapshot | null | undefined,
): Promise<MoneyRecipient> {
  if (memberId === null) {
    // Non-member event buyer: no contact row exists to read.
    const snapshotEmail = snapshot?.primary_contact_email ?? '';
    return snapshotEmail.trim() === ''
      ? { kind: 'no_recipient' }
      : { kind: 'non_member', email: snapshotEmail };
  }

  const live = await port.getMemberEmailRecipient(tx, tenantId, memberId);
  // An odd-looking or previously-bounced address is still THE address (FR-001b) —
  // deliverability is the dispatcher's problem. Only a genuinely empty column is
  // undeliverable, and an empty one means "no recipient", not "use the snapshot".
  if (live === null || live.email.trim() === '') return { kind: 'no_recipient' };
  return { kind: 'member', email: live.email, locale: live.locale };
}
