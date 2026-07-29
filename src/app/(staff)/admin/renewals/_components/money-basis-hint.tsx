/**
 * renewals-overdue-prior-fy-subline — info affordance for a money KPI tile
 * whose basis legitimately diverges from a look-alike figure on another page
 * (first use: the Collection-rate tile's settled leg counts by DUE fiscal
 * year; the F9 dashboard's "Paid revenue" counts by ISSUE year — users
 * comparing the two pages need the divergence explained in place).
 *
 * UX-review follow-up F1 — thin wrapper over the shared `InfoHint` system
 * pattern (Base UI Popover: click/tap/Enter/Space to open, ESC + outside
 * click to close, touch-reachable — the original hover/focus-only Tooltip
 * was not). Public usage in `pipeline-money-band.tsx` is unchanged; the
 * `tooltipText` prop name is kept for that reason. `-my-1` keeps the 24px
 * hit target (WCAG 2.2 SC 2.5.8) from stretching the compact tile's label
 * row. No 'use client' needed any more — `InfoHint` owns the client
 * boundary and only serialisable string props cross it.
 */
import { InfoHint } from '@/components/ui/info-hint';

export function MoneyBasisHint({
  ariaLabel,
  tooltipText,
}: {
  readonly ariaLabel: string;
  readonly tooltipText: string;
}) {
  return (
    <InfoHint ariaLabel={ariaLabel} triggerClassName="-my-1">
      {tooltipText}
    </InfoHint>
  );
}
