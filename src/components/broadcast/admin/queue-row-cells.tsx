'use client';

/**
 * F119 T117 / T118 — the cells the queue's desktop table and its phone card
 * list both render, in one place so the two presentations cannot drift apart
 * (the `ageBadge` struct's own rule, one level up). `SendTime` is table-only:
 * below `md` the send times live on the detail page (FR-026).
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

/**
 * UX review M1 — the two FR-026 send times in one cell. The confirmed time
 * when marketing has confirmed one; before that the member's proposal, marked
 * "Proposed". When the confirmed time differs from the proposal, the proposal
 * stays on a second line, so both FR-026 times are still on the row. "—" when
 * neither exists (a draft, or a row that predates the proposal column).
 *
 * The marker is a label, so it alone is muted (M6); the times are values.
 */
export function SendTime({
  row,
  proposedLabel,
}: {
  readonly row: Pick<EnrichedQueueRow, 'proposedSendAtFormatted' | 'confirmedSendAtFormatted'>;
  readonly proposedLabel: string;
}): React.JSX.Element {
  const { confirmedSendAtFormatted: confirmed, proposedSendAtFormatted: proposed } = row;
  if (confirmed === null && proposed === null) return <EmptySentinel />;
  if (confirmed === null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="whitespace-nowrap tabular-nums">{proposed}</span>
        <span className="text-xs text-muted-foreground">{proposedLabel}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="whitespace-nowrap tabular-nums">{confirmed}</span>
      {proposed !== null && proposed !== confirmed ? (
        <span className="text-xs">
          <span className="text-muted-foreground">{proposedLabel}</span>{' '}
          <span className="whitespace-nowrap tabular-nums">{proposed}</span>
        </span>
      ) : null}
    </div>
  );
}
