/**
 * 108 FR-004 — the address F5 hands to the payment processor.
 *
 * Stripe requires `payment_method_data.billing_details.email` on a
 * server-confirmed PromptPay PaymentIntent, and mails its own receipt there.
 * That address must be the MEMBER's primary contact — the company's billing
 * address of record — not whichever portal user happened to click Pay. A
 * secondary contact with a login can pay the company's invoice; Stripe's
 * receipt must still go to the primary contact, exactly like every F4 money
 * email (`invoicing/application/lib/resolve-money-recipient.ts`).
 *
 * `null` means "this member has no contact with `is_primary = true AND
 * removed_at IS NULL`". There is no fallback: PromptPay fails with a permanent
 * `primary_contact_missing` BEFORE anything is created at the processor, so
 * there is never an orphan PaymentIntent to reconcile. Card is unaffected —
 * Stripe Elements collects billing details client-side and we share no address.
 */
export interface BillingRecipientPort {
  getPrimaryContactEmail(tenantId: string, memberId: string): Promise<string | null>;
}
