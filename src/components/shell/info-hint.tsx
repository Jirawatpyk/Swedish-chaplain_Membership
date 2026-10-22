'use client';

/**
 * Spec 122 — the ⓘ "explain this" affordance on AURA: an info `IconButton`
 * that opens an AURA Popover (click / tap / Enter / Space; Esc and an outside
 * click close it). A popover, not a tooltip, because the copy has to reach
 * touch users (the legacy `InfoHint` made the same call). It is the same
 * 32px `IconButton` as every other help ⓘ in the app, with AURA's 44px hit
 * area (relay R70b). Callers in a tight row pass `triggerClassName="-my-1"`
 * so the button does not stretch the row.
 */
import type { ReactNode } from 'react';
import { IconButton, Popover } from '@jirawatpyk/aura-react';

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
      trigger={<IconButton icon="info" label={ariaLabel} size="sm" {...(triggerClassName ? { className: triggerClassName } : {})} />}
    >
      <p className="m-0 text-xs">{children}</p>
    </Popover>
  );
}
