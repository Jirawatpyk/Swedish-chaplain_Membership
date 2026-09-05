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
import type { F4OutboxEventType, F4OutboxLocale } from '../ports/email-outbox-port';
import type { AuditPort } from '../ports/audit-port';
import { invoicingMetrics } from '@/lib/metrics';

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
  // Both arms return the TRIMMED value they tested. Testing `.trim()` and then
  // returning the raw column handed `'  a@b.com  '` straight to Stripe's
  // `billing_details.email` and to `notifications_outbox.to_email`, where it
  // reads as a rejected address or a silently dead-lettered row. FR-001b's "an
  // odd-looking address is still THE address" is about the address itself, not
  // about padding around it — whitespace is a data-entry artifact and carries
  // no information a recipient could want.
  if (memberId === null) {
    // Non-member event buyer: no contact row exists to read.
    const snapshotEmail = (snapshot?.primary_contact_email ?? '').trim();
    return snapshotEmail === ''
      ? { kind: 'no_recipient' }
      : { kind: 'non_member', email: snapshotEmail };
  }

  const live = await port.getMemberEmailRecipient(tx, tenantId, memberId);
  // An odd-looking or previously-bounced address is still THE address (FR-001b) —
  // deliverability is the dispatcher's problem. Only a genuinely empty column is
  // undeliverable, and an empty one means "no recipient", not "use the snapshot".
  if (live === null) return { kind: 'no_recipient' };
  const email = live.email.trim();
  if (email === '') return { kind: 'no_recipient' };
  return { kind: 'member', email, locale: live.locale };
}

/**
 * 108 FR-004 — record that a money email was skipped because the member has no
 * live primary contact.
 *
 * Without this row the skip is invisible: the payment settles, the void or
 * credit note is issued, and nobody can reconstruct which documents never
 * reached the member. The metric bump gives ops an alertable signal; the audit
 * row gives an auditor the per-document trail.
 *
 * Payload keys, deliberately:
 *   • `related_member_id`, NOT `member_id`. Two mechanisms read the payload and
 *     they want different things: migration 0009's trigger bumps
 *     `members.last_activity_at` for any row carrying `member_id` (a skipped
 *     email is NOT member activity — stamping it would inflate the at-risk
 *     scorer's recency for exactly the members whose contact data is broken),
 *     while F9's `member_timeline_v` selects
 *     `COALESCE(member_id, related_member_id)`. `related_member_id` is the key
 *     that satisfies both: the row surfaces on the member's timeline, where an
 *     admin asking "why did they never get their receipt?" will actually look,
 *     and the trigger stays asleep. F9 added that COALESCE for this exact
 *     shape; this is its first emitter.
 *   • `email_event_type` — which mail was skipped; not named `event_type` so it
 *     never reads as a second copy of `audit_log.event_type`.
 *   • no address and no contact PII — there is no address; that IS the event.
 *
 * `tx` follows `AuditPort.emit`: the caller's open money tx on the mutation
 * paths (so the skip rolls back with a failed payment), `null` on the resend
 * path, which has no tx of its own.
 */
export async function auditAutoEmailSkippedNoRecipient(
  audit: AuditPort,
  tx: unknown,
  args: {
    readonly tenantId: string;
    readonly requestId: string | null;
    readonly actorUserId: string;
    readonly memberId: string;
    readonly emailEventType: F4OutboxEventType;
    /**
     * Metric label. A credit-note RESEND holds only a `CreditNote`, which
     * carries no invoice subject — it passes `'unknown'` rather than guessing
     * (a matched-member event CN counted as membership would be a lie) and
     * rather than omitting the label, which is what it used to do: the counter
     * then never fired for that path at all, so a dashboard on
     * `invoicing.auto_email_skipped` under-reported every §86/10 resend that
     * reached nobody (round-5 finding #7). Still optional so a caller with no
     * label at all lands the audit row without a counter.
     */
    readonly subject?: 'membership' | 'event' | 'unknown';
    readonly invoiceId?: string;
    readonly creditNoteId?: string;
  },
): Promise<void> {
  await audit.emit(tx, {
    tenantId: args.tenantId,
    requestId: args.requestId,
    eventType: 'auto_email_skipped_no_recipient',
    actorUserId: args.actorUserId,
    summary: `Auto-email ${args.emailEventType} skipped — member has no primary contact`,
    payload: {
      related_member_id: args.memberId,
      email_event_type: args.emailEventType,
      ...(args.invoiceId === undefined ? {} : { invoice_id: args.invoiceId }),
      ...(args.creditNoteId === undefined ? {} : { credit_note_id: args.creditNoteId }),
    },
  });
  // AFTER the emit, not before (round-4 finding #14). The audit row is written
  // on the caller's money tx and rolls back with it; the counter cannot roll
  // back. Bumping first meant a settlement that later unwound left a skip
  // counted that never happened, and a webhook retry counted it again on each
  // attempt. The sharper case is the emit itself throwing — an
  // `auto_email_skipped_no_recipient` value missing from the prod enum because
  // migration 0292 has not been applied — where the counter fired and the
  // exception then propagated out of the payment transaction.
  if (args.subject !== undefined) {
    invoicingMetrics.autoEmailSkipped(args.subject, 'no_recipient');
  }
}
