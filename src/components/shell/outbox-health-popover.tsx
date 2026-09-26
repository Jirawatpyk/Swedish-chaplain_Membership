'use client';

import { AlertTriangle } from 'lucide-react';
import { Popover } from '@jirawatpyk/aura-react';

import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

/**
 * Spec 122 US1 — the client half of `OutboxHealthBadge`: an amber warning
 * button that opens an AURA `Popover` with the counts. A popover, not a
 * tooltip: it opens on a tap too, so touch users get the numbers (a tooltip
 * only shows on hover or focus). The server component does the counting and
 * passes plain strings (server files never import AURA — see
 * docs/aura-adoption.md).
 */
export function OutboxHealthPopover({ label, lines }: { readonly label: string; readonly lines: readonly string[] }) {
  return (
    <Popover
      label={label}
      placement="bottom-end"
      trigger={
        <button
          type="button"
          aria-label={label}
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--aura-radius-md)] text-[var(--aura-alert-warning-fg)] hover:bg-[var(--aura-bg-surface-hover)] pointer-coarse:size-11',
            AURA_FOCUS_RING,
          )}
        >
          <AlertTriangle className="size-4" aria-hidden />
        </button>
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
