/**
 * 108 FR-004 — the address F5 hands to the payment processor.
 *
 * Stripe requires `payment_method_data.billing_details.email` on a
 * server-confirmed PromptPay PaymentIntent, and mails its own receipt there.
 * That address must be the MEMBER's primary contact — the company's billing
 * address of record — not whichever portal user clicked Pay. A secondary
 * contact with a login can pay the company's invoice; Stripe's receipt must
 * still go to the primary contact, exactly like every F4 money email
 * (`invoicing/application/lib/resolve-money-recipient.ts`).
 *
 * ## Why this returns a Result and not `string | null`
 *
 * The first version collapsed a repo FAILURE into the same `null` that means
 * "this member genuinely has no primary contact". A Neon hiccup then surfaced
 * as the permanent error `primary_contact_missing` — telling a member with a
 * perfectly good contact that their membership has none, and sending them to an
 * admin who would find nothing wrong. This use case had already ruled on that
 * exact class once: `invoice_read_failed` exists because "telling a member
 * their invoice cannot be paid because a database read hiccuped is a lie that
 * sends them to support".
 *
 * So the two are separated at the port:
 *   • `ok(string)`        — the member's live primary contact address.
 *   • `ok(null)`          — no contact with `is_primary AND removed_at IS NULL`.
 *                           PERMANENT: PromptPay refuses with
 *                           `primary_contact_missing` (409, staff-actionable).
 *   • `err('read_failed')`— we could not find out. TRANSIENT: surfaces as a 500,
 *                           the same shape a thrown read produced before.
 *
 * Card is unaffected either way — Stripe Elements collects billing details
 * client-side and we share no address at all, so a card payment neither reads
 * this port nor fails when a member has no primary contact.
 */
import type { Result } from '@/lib/result';

export interface BillingRecipientReadFailed {
  readonly kind: 'read_failed';
}

export interface BillingRecipientPort {
  getPrimaryContactEmail(
    tenantId: string,
    memberId: string,
  ): Promise<Result<string | null, BillingRecipientReadFailed>>;
}
