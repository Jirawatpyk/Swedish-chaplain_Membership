'use client';

/**
 * UX I13 — Disabled compose button with explanatory tooltip.
 *
 * When member quota is exhausted, the e-blasts page renders a disabled
 * compose button. Bare disabled buttons are mystery-disabled (WCAG SC
 * 3.3.2). This component wraps the disabled button in a Tooltip that
 * explains "Renews on Jan 1 of <year+1>".
 *
 * 122 US12d-1 (T1234): AURA Button + Tooltip; the plus icon matches the
 * enabled Compose E-Blast button beside it (board `Portal-broadcasts`).
 */
import { Button, Tooltip } from '@jirawatpyk/aura-react';

export interface ComposeButtonWithTooltipProps {
  readonly label: string;
  readonly tooltipText: string;
}

export function ComposeButtonWithTooltip({
  label,
  tooltipText,
}: ComposeButtonWithTooltipProps): React.ReactElement {
  return (
    // `aria-disabled` instead of `disabled` so the tooltip can still anchor
    // to a focusable element; AURA's Button keeps the passed aria-disabled
    // and ignores clicks (5.14, handoff 102).
    // UX-R2-4 (round-3) — `aria-label` permanently combines the visible
    // label + tooltip hint so SR users hear "Compose your first E-Blast —
    // Renews January 1…" instead of bare "Compose, dimmed" (a tooltip only
    // describes the trigger while it is open).
    <Tooltip content={tooltipText}>
      <Button
        type="button"
        variant="primary"
        icon="plus"
        touchHeight
        fullWidth="below-sm"
        aria-disabled="true"
        aria-label={`${label} — ${tooltipText}`}
      >
        {label}
      </Button>
    </Tooltip>
  );
}
