/**
 * Skeleton for the member-detail Invoices section — US7 AS1. The same card
 * frame as `MemberInvoicesSection`, so the layout doesn't jump when the server
 * stream completes (ux-standards § 2.1); the page's `getMember` no longer
 * blocks on the invoice fetch. Spec 122 US5b-1: the shared AURA section
 * skeleton.
 */
import { SectionCardSkeleton } from './section-card-skeleton';

export function MemberInvoicesSkeleton(): React.ReactElement {
  return <SectionCardSkeleton rows={3} action />;
}
