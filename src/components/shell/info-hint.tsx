'use client';

/**
 * Spec 122 — the ⓘ "explain this" affordance on AURA: a 24px button that
 * opens an AURA Popover (click / tap / Enter / Space; Esc and an outside
 * click close it). A popover, not a tooltip, because the copy has to reach
 * touch users (the legacy `InfoHint` made the same call). Callers in a tight
 * text row pass `triggerClassName="-my-1"` so the button does not stretch the
 * line.
 */
import type { ReactNode } from 'react';
import { Icon, Popover } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';

export function InfoHint({
  ariaLabel,
  children,
  triggerClassName,
}: {
  /** Accessible name for the ⓘ button. */
  readonly ariaLabel: string;
  /** The popover's explanation copy. */
  readonly children: ReactNode;
  readonly triggerClassName?: string;
}) {
  return (
    <Popover
      label={ariaLabel}
      width={280}
      trigger={
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--aura-radius-sm)] text-[var(--aura-fg-secondary)] hover:text-[var(--aura-fg-primary)]',
            triggerClassName,
          )}
        >
          <Icon name="info" size="sm" />
        </button>
      }
    >
      <p className="m-0 text-xs">{children}</p>
    </Popover>
  );
}
