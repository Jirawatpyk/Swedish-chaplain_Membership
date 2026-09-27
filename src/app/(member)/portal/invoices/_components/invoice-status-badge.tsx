/**
 * 060-member-portal-d4 (final /speckit-review simplification) — shared
 * invoice status badge for the member-portal invoice surfaces.
 *
 * The status-badge JSX (resolve the lucide icon for the status, render a
 * shadcn <Badge> with the variant + an aria-hidden icon + the localised
 * label) was copy-pasted across FOUR portal surfaces — the list table
 * (page.tsx), the summary card (invoices-summary-card.tsx), the mobile card
 * list (portal-invoice-card-list.tsx), and the detail page
 * ([invoiceId]/page.tsx). Two of those wrapped it in an IIFE purely to bind
 * the resolved `Icon` component before using it in JSX.
 *
 * Consolidated here (a Server Component — no `'use client'`; it only renders
 * static markup) so the status → variant + icon + size + aria pairing has a
 * SINGLE source of truth and can never drift between surfaces. Behaviour is
 * byte-identical to the four former call sites: same Badge variant
 * (`statusBadgeVariant`), same lucide icon (`statusIcon`) at `size-3.5` with
 * `aria-hidden="true"`, same `inline-flex items-center gap-1` base classes,
 * and the same caller-supplied label text.
 *
 * The mobile card list additionally needs `shrink-0` on its badge (so the
 * badge does not compress when the doc-number link is long); that surface
 * passes it via the `className` prop, which `cn(...)` merges onto the base
 * classes — keeping every former class present.
 *
 * Spec 122 US4 (T401): an AURA StatusPill in the boards' tones
 * (`invoiceStatusTone`). The pill draws its own status icon beside the
 * word, so the lucide icon and the Badge variant are gone.
 *
 * NOTE: the ADMIN invoice table (`app/(staff)/admin/.../invoice-table.tsx`)
 * has its OWN separate `StatusBadge` over a different RowStatus/variant
 * vocabulary — it is intentionally NOT consolidated here.
 */
import { StatusPill } from '@jirawatpyk/aura-react/server';
import { invoiceStatusTone, type InvoiceRowDisplayStatus } from '../_utils/format';

export function InvoiceStatusBadge({
  status,
  label,
  className,
}: {
  readonly status: InvoiceRowDisplayStatus;
  readonly label: string;
  readonly className?: string;
}): React.ReactElement {
  return (
    <StatusPill tone={invoiceStatusTone(status)} className={className}>
      {label}
    </StatusPill>
  );
}
