/**
 * renewals-suspended-visibility-audit — the "suspended population bridge"
 * strip. Solves a real operator confusion: the Members page said
 * "Suspended 15" while the pipeline's Suspended urgency tab showed 4 — the
 * other 11 were `awaiting_payment` cycles whose fixed-anchor `expires_at`
 * lies beyond the FR-046 90-day work window (first-bill collection cases),
 * so they appear in NO urgency bucket. This muted single-line strip makes
 * the two numbers explain themselves: total = in-queue + outside-window.
 *
 * Link honesty (operator-rejected superset fix, Task 3.2): the EXACT
 * outside-window cohort is NOT URL-expressible — the invoices list filters
 * by invoice fields (status/subject/due date), not by the owning member's
 * renewal-cycle window position, and no such cycle-scoped param exists. So
 * the link goes to `/admin/invoices?status=issued&subject=membership`
 * (every unpaid membership bill) and its TEXT promises exactly that
 * ("view all unpaid membership bills") instead of implying an exact-N
 * landing; the counts live in the non-link part of the sentence.
 *
 * Renders NOTHING when the outside-window count is 0 (no layout shift for
 * the common case). Muted text-sm styling matches the page's sibling
 * caption conventions (`ResultCountLabel`); the link is keyboard-focusable
 * with the standard focus ring + hover underline (money-band subline
 * precedent).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';

export function SuspendedBridgeStrip({
  inWindowCount,
  outsideWindowCount,
}: {
  /**
   * `summary.suspendedInWindowGlobalCount` — suspended cycles INSIDE the
   * work window, TENANT-GLOBAL (#292 review A3): NOT the tier-sliced
   * badge. The copy's "in this renewal queue" reads as the whole queue —
   * which is exactly what a global number describes — so the sentence
   * stays correct while a tier filter narrows the badges around it.
   */
  readonly inWindowCount: number;
  /** `summary.suspendedOutsideWindowCount` — suspended cycles beyond it (also tenant-global). */
  readonly outsideWindowCount: number;
}) {
  const t = useTranslations('admin.renewals.suspendedBridge');
  if (outsideWindowCount <= 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {t.rich('line', {
        total: inWindowCount + outsideWindowCount,
        inWindow: inWindowCount,
        outside: outsideWindowCount,
        link: (chunks) => (
          // B1 (UX review) — PERSISTENT underline, not hover-only: a
          // mid-sentence link inside muted body text has no other
          // non-color affordance, so hover-only fails WCAG 1.4.1 (the
          // #288 draft-label lesson). Colour stays muted; the underline
          // carries the "this is a link" signal.
          <Link
            href="/admin/invoices?status=issued&subject=membership"
            className="rounded-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
