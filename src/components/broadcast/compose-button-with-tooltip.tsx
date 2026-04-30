'use client';

/**
 * UX I13 — Disabled compose button with explanatory tooltip.
 *
 * When member quota is exhausted, the e-blasts page renders a disabled
 * compose button. Bare disabled buttons are mystery-disabled (WCAG SC
 * 3.3.2). This component wraps the disabled button in a Tooltip that
 * explains "Renews on Jan 1 of <year+1>".
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';

export interface ComposeButtonWithTooltipProps {
  readonly label: string;
  readonly tooltipText: string;
}

export function ComposeButtonWithTooltip({
  label,
  tooltipText,
}: ComposeButtonWithTooltipProps): React.ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            // `aria-disabled` instead of `disabled` so the tooltip can
            // still anchor to a focusable element. The button rejects
            // clicks via the no-op onClick.
            <Button
              type="button"
              aria-disabled="true"
              tabIndex={0}
              onClick={(e) => e.preventDefault()}
              className="cursor-not-allowed opacity-60"
            >
              {label}
            </Button>
          }
        />
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
