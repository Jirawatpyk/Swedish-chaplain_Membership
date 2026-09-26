'use client';

import { AlertTriangle } from 'lucide-react';
import { Tooltip } from '@jirawatpyk/aura-react';

import { AURA_FOCUS_RING } from '@/components/shell/aura-classes';
import { cn } from '@/lib/utils';

/**
 * Spec 122 US1 — the client half of `OutboxHealthBadge`: an amber warning
 * button with an AURA `Tooltip`. The server component does the counting and
 * passes plain strings (server files never import AURA — see
 * docs/aura-adoption.md).
 */
export function OutboxHealthTooltip({ label, lines }: { readonly label: string; readonly lines: readonly string[] }) {
  return (
    <Tooltip
      side="bottom"
      content={
        <span className="flex max-w-xs flex-col gap-1">
          <span className="font-medium">{label}</span>
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      }
    >
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
    </Tooltip>
  );
}
