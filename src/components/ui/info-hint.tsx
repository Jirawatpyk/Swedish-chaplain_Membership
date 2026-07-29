'use client';

/**
 * InfoHint — the SYSTEM pattern for a small ⓘ "explain this figure/term"
 * affordance (UX-review follow-up F1, renewals-overdue-prior-fy-subline).
 *
 * Base UI **Popover**, deliberately NOT Tooltip: a hover/focus-only tooltip
 * is unreachable on touch devices, and the first two shipped hints (T160
 * `CombinedReceiptHint`, the renewals money-band basis hint) both carry
 * copy a phone user needs. Popover semantics:
 *   - opens on click/tap and on Enter/Space (native `<button>` trigger —
 *     Base UI's default element, NOT a `render={<span/>}` override, which
 *     is exactly how the T160 regression lost keyboard focusability);
 *   - closes on ESC and outside click/tap (Base UI defaults);
 *   - Base UI wires `aria-expanded`/`aria-haspopup`/`aria-controls` on the
 *     trigger and the popup's dialog role — no manual ARIA here beyond the
 *     accessible name (`ariaLabel`);
 *   - reduced-motion: covered by the global `[data-open]` overlay override,
 *     same as every other Base UI popup surface.
 *
 * Layout: 24×24px hit target (WCAG 2.2 SC 2.5.8). Call sites embedding the
 * button in a tight text row can pass `triggerClassName="-my-1"` so the
 * 24px box doesn't stretch the line height.
 */
import type { ReactNode } from 'react';
import { InfoIcon } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function InfoHint({
  ariaLabel,
  children,
  triggerClassName,
}: {
  /** Accessible name for the ⓘ button (what a screen reader announces). */
  readonly ariaLabel: string;
  /** Popover body — the explanation copy. */
  readonly children: ReactNode;
  /** Extra classes for the trigger button (e.g. `-my-1` in tight rows). */
  readonly triggerClassName?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={ariaLabel}
        className={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          triggerClassName,
        )}
      >
        <InfoIcon className="size-3.5" aria-hidden="true" />
      </PopoverTrigger>
      {/* `w-auto max-w-xs text-xs` overrides the default fixed `w-72
          text-sm` panel — hint copy is a sentence or two, so the panel
          should hug it, matching the old tooltip's footprint. */}
      <PopoverContent className="w-auto max-w-xs text-xs">
        {children}
      </PopoverContent>
    </Popover>
  );
}
