'use client';

import { AlertTriangle } from 'lucide-react';
import { IconButton, Popover } from '@jirawatpyk/aura-react';

/**
 * Spec 122 US1 — the client half of `OutboxHealthBadge`: an amber warning
 * button that opens an AURA `Popover` with the counts. A popover, not a
 * tooltip: it opens on a tap too, so touch users get the numbers (a tooltip
 * only shows on hover or focus). The trigger is the same `IconButton` with
 * `touchHeight` as the bar's search and theme buttons (32px with a mouse
 * from 640px, 44px on a phone or a touch screen), in the warning colour.
 * The server component does the counting and
 * passes plain strings (server files never import AURA — see
 * docs/aura-adoption.md).
 */
export function OutboxHealthPopover({ label, lines }: { readonly label: string; readonly lines: readonly string[] }) {
  return (
    <Popover
      label={label}
      placement="bottom-end"
      trigger={
        <IconButton
          icon={<AlertTriangle className="size-4" aria-hidden />}
          label={label}
          touchHeight
          className="text-[var(--aura-alert-warning-fg)]"
        />
      }
    >
      <div className="flex max-w-xs flex-col gap-1 text-sm">
        <p className="font-medium">{label}</p>
        {lines.map((line) => (
          <p key={line} className="text-[var(--aura-fg-secondary)]">
            {line}
          </p>
        ))}
      </div>
    </Popover>
  );
}
