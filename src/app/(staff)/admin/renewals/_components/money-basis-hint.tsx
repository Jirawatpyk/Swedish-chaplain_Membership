'use client';

/**
 * renewals-overdue-prior-fy-subline — info-tooltip affordance for a money
 * KPI tile whose basis legitimately diverges from a look-alike figure on
 * another page (first use: the Collection-rate tile's settled leg counts by
 * DUE fiscal year; the F9 dashboard's "Paid revenue" counts by ISSUE year —
 * users comparing the two pages need the divergence explained in place).
 *
 * Client Component for the same reason as `CombinedReceiptHint`
 * (portal-invoices): the tooltip subtree cannot be inlined in a Server
 * Component under React 19 + Next.js 16 strict SC/CC boundaries.
 *
 * Keyboard accessibility (docs/ux-standards.md): the trigger is Base UI's
 * DEFAULT `<button>` (natively focusable, tooltip opens on focus, Base UI
 * wires `aria-describedby` to the open popup) — deliberately NOT the
 * `render={<span/>}` override `CombinedReceiptHint` uses, which loses
 * focusability. 24×24px hit target (WCAG 2.2 SC 2.5.8); `-my-1` keeps the
 * 24px box from stretching the compact tile's label row.
 */
import { InfoIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function MoneyBasisHint({
  ariaLabel,
  tooltipText,
}: {
  readonly ariaLabel: string;
  readonly tooltipText: string;
}) {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          aria-label={ariaLabel}
          className="-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <InfoIcon className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
