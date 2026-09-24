'use client';

/**
 * F119 T117 / T118 — the two cells the queue's desktop table and its phone
 * card list both render, in one place so the two presentations cannot drift
 * apart (the `ageBadge` struct's own rule, one level up).
 */
import { AlertCircle, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { EnrichedQueueRow } from './queue-table-client';

/** The empty-value sentinel "—" — the one place a new FR-026 cell uses `muted-foreground`. */
export function EmptySentinel(): React.JSX.Element {
  return <span className="text-muted-foreground">—</span>;
}

/**
 * Time in stage: the SLA badge when the row is aging or stalled, the plain
 * duration when it is waiting but fresh, "—" when nobody is waiting.
 *
 * The badge is a role-less span whose visible text IS its accessible name
 * ("Stalled — 3 days"): the icon is `aria-hidden` and there is no
 * `aria-label` (prohibited on a role-less element). Icon + text, never
 * colour alone (FR-027).
 */
export function TimeInStage({
  row,
}: {
  readonly row: Pick<EnrichedQueueRow, 'ageBadge' | 'timeInStageLabel'>;
}): React.JSX.Element {
  if (row.ageBadge !== null) {
    return (
      <Badge
        variant="outline"
        className={cn(
          'inline-flex items-center gap-1 self-start align-middle text-xs',
          row.ageBadge.variant === 'red'
            ? 'border-destructive/40 bg-destructive-surface text-destructive'
            : 'border-warning/40 bg-warning-surface text-warning',
        )}
      >
        {/* UX-R2-7 (round-3) — non-color signal for color-blind users */}
        {row.ageBadge.variant === 'red' ? (
          <AlertCircle className="h-3 w-3" aria-hidden="true" />
        ) : (
          <Clock className="h-3 w-3" aria-hidden="true" />
        )}
        {row.ageBadge.label}
      </Badge>
    );
  }
  if (row.timeInStageLabel === null) return <EmptySentinel />;
  return <span className="tabular-nums text-foreground">{row.timeInStageLabel}</span>;
}
