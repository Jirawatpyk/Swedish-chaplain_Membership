/**
 * 060-member-portal-d4 — shared empty-cell sentinel for /portal/invoices.
 *
 * The "nothing to show" em-dash rendered in three places on the invoices
 * list (the desktop table's receipt-number cell, the desktop table's
 * actions cell, and the mobile card's actions slot). Extracted to a single
 * component so the markup can never drift across the three call sites.
 *
 * The em-dash is purely DECORATIVE — it is a visual placeholder for an
 * empty cell, not content a screen reader needs to announce (the absence
 * of a receipt number / action buttons is already conveyed by the
 * surrounding structure). `aria-hidden="true"` keeps it out of the a11y
 * tree so SR users are not read a meaningless "em dash".
 */
export function EmptyCell(): React.ReactElement {
  return (
    <span className="text-sm text-muted-foreground" aria-hidden="true">
      —
    </span>
  );
}
