/**
 * renewals-overdue-prior-fy-subline — info affordance for a money KPI tile
 * whose basis legitimately diverges from a look-alike figure on another page
 * (first use: the Collection-rate tile's settled leg counts by DUE fiscal
 * year; the F9 dashboard's "Paid revenue" counts by ISSUE year — users
 * comparing the two pages need the divergence explained in place).
 *
 * 122 US7a (T704): AURA `Popover` behind an info `IconButton` — click, tap,
 * Enter or Space opens it; Escape and an outside click close it (touch- and
 * keyboard-reachable, never hover-only).
 */
'use client';

import { IconButton, Popover } from '@jirawatpyk/aura-react';

export function MoneyBasisHint({
  ariaLabel,
  tooltipText,
}: {
  readonly ariaLabel: string;
  readonly tooltipText: string;
}) {
  return (
    <Popover
      label={ariaLabel}
      placement="bottom-start"
      width={320}
      trigger={<IconButton icon="info" label={ariaLabel} size="sm" />}
    >
      <p className="text-[var(--aura-fg-secondary)]">{tooltipText}</p>
    </Popover>
  );
}
