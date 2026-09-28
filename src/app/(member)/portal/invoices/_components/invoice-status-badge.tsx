/**
 * 060-member-portal-d4 (final /speckit-review simplification) — shared
 * invoice status badge for the member-portal invoice surfaces.
 *
 * The status badge was copy-pasted across four portal surfaces (the list
 * table, the summary card, the mobile card list and the detail page);
 * consolidated here (a Server Component — static markup only) so the
 * status → look pairing has a single source of truth. Callers pass the
 * localised label and, where needed, extra classes (`className`).
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
