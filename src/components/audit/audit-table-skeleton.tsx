/**
 * Skeleton for the read-only <AuditTable> (F9 US2).
 *
 * The real table is AURA's static `Table`, which sizes its columns to the
 * content, so the skeleton is the same `Table` with each column's share of the
 * real one at a 1440px window (StaticTableSkeleton): the columns sit where
 * the real ones land at any width, edge to edge in the card and stacked into
 * cards below 640px. Time, event, actor and summary are two lines (dual
 * timestamp, label + raw code, name + role, wrapping summary); the payload
 * pairs three, so the shell does not shift when the rows land.
 */
import { StaticTableSkeleton } from '@/components/shell/static-table-skeleton';

export interface AuditTableSkeletonLabels {
  readonly caption: string;
  readonly time: string;
  readonly event: string;
  readonly actor: string;
  readonly target: string;
  readonly summary: string;
  readonly payload: string;
}

export function AuditTableSkeleton({ labels }: { readonly labels: AuditTableSkeletonLabels }): React.JSX.Element {
  return (
    <StaticTableSkeleton
      caption={labels.caption}
      rows={8}
      columns={[
        { label: labels.time, share: '19%', lines: 2 },
        { label: labels.event, share: '22%', lines: 2, card: 'title' },
        { label: labels.actor, share: '9%', lines: 2 },
        { label: labels.target, share: '17%' },
        { label: labels.summary, share: '17%', lines: 2 },
        { label: labels.payload, share: '16%', lines: 3 },
      ]}
    />
  );
}
