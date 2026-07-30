/**
 * The full-card "no renewals due" empty state must only replace the pipeline
 * when NO filter is active. A tier filter OR the renewals-by-month lens each
 * count as an active filter — with a filter on, an empty result belongs in the
 * table body ("No members renew in {month}" / bucket copy), never the full-card
 * illustration (which tears out the filter controls). Omitting the month lens
 * here blanked the pipeline for the exact tenant the feature targets
 * (renewals clustered outside the 90-day urgency window).
 *
 * A2 (renewals-suspended-visibility-audit UX review) — deliberately NOT
 * gated on `suspendedOutsideWindowCount`: "no renewals due in the window"
 * stays true for the launch-shaped tenant whose members are all first-bill
 * collection cases beyond the window. `RenewalsEmptyState` instead ACCEPTS
 * the suspended counts and renders the bridge strip beneath the card, so
 * the context is added rather than the empty state torn out.
 */
export function shouldShowRenewalsEmptyState(args: {
  readonly monthLensActive: boolean;
  readonly tierSelected: boolean;
  readonly totalInWindow: number;
  readonly lapsedCount: number;
}): boolean {
  return (
    !args.monthLensActive &&
    !args.tierSelected &&
    args.totalInWindow === 0 &&
    args.lapsedCount === 0
  );
}
