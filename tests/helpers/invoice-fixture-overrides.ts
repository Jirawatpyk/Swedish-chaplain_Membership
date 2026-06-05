/**
 * 054-event-fee-invoices — shared override type for Invoice test factories.
 *
 * `Invoice` is a DISCRIMINATED UNION on `invoiceSubject` (domain/invoice.ts),
 * so `Partial<Invoice>` distributes to `Partial<membershipArm> |
 * Partial<eventArm>` — which a test factory cannot spread into a single literal
 * and reassign back to `Invoice` (TS cannot collapse the union). Test factories
 * therefore type their `overrides` parameter as this FLATTENED partial: every
 * subject-specific field widened to its cross-arm union type, so a fixture can
 * flip a membership default into an event invoice (or vice-versa) in one
 * `overrides` object. The factory still RETURNS `Invoice` (with the existing
 * `as Invoice` boundary assertion), so call sites that consume the fixture get
 * the full discriminated union and must narrow on `invoiceSubject` as usual.
 *
 * This is a TEST-ONLY convenience: production code never constructs an Invoice
 * from a flattened shape — the repo seam (`rowToSubjectFields`) builds the
 * correct arm and the DB CHECK `invoices_subject_fields_ck` rejects illegal
 * rows. A couple of fixtures intentionally build a CHECK-violating shape (e.g.
 * event subject with a null `event_registration_id`) to exercise a
 * defence-in-depth runtime guard; the flattened type permits that on purpose.
 */
import type { Invoice } from '@/modules/invoicing/domain/invoice';

/** Every Invoice field with the subject discriminant + identity widened. */
type FlatInvoice = Omit<
  Invoice,
  | 'invoiceSubject'
  | 'memberId'
  | 'planId'
  | 'planYear'
  | 'eventId'
  | 'eventRegistrationId'
  | 'vatInclusive'
> & {
  readonly invoiceSubject: 'membership' | 'event';
  readonly memberId: string | null;
  readonly planId: string | null;
  readonly planYear: number | null;
  readonly eventId: string | null;
  readonly eventRegistrationId: string | null;
  readonly vatInclusive: boolean;
};

/**
 * Loosely-typed `overrides` shape for Invoice test factories. Accepts any field
 * of either union arm; lets a membership-default factory be overridden into an
 * event invoice without per-field casts at the call site.
 */
export type InvoiceFixtureOverrides = Partial<FlatInvoice>;
