'use client';

/**
 * F4 portal-invoices `combined-mode` receipt-number hint.
 *
 * For combined-mode tenants the receipt PDF reuses the invoice
 * document number, so the receipt-number cell shows an em-dash with
 * an inline tooltip explaining the convention. The whole Radix
 * tooltip subtree needs to live in a Client Component because
 * `Tooltip.Trigger`'s `render` prop is a function — passing a
 * function from a Server Component to a Client Component throws the
 * "Functions cannot be passed directly to Client Components" error
 * under React 19 + Next.js 16 strict SC/CC boundaries.
 *
 * Pre-fix this whole subtree was inlined in `page.tsx` (Server
 * Component) — caused /portal/invoices to render the global error
 * boundary instead of the table on every request.
 */
import { InfoIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface CombinedReceiptHintProps {
  readonly ariaLabel: string;
  readonly tooltipText: string;
}

export function CombinedReceiptHint({
  ariaLabel,
  tooltipText,
}: CombinedReceiptHintProps): React.ReactElement {
  return (
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={(props) => (
            <span
              {...props}
              className="inline-flex min-h-6 items-center gap-1 text-sm text-muted-foreground cursor-help"
              aria-label={ariaLabel}
            >
              —
              <InfoIcon className="size-3.5" aria-hidden="true" />
            </span>
          )}
        />
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
