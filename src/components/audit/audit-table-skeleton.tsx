/**
 * Skeleton for the read-only <AuditTable> (F9 US2).
 *
 * Spec 122 US10b (T1013): AURA's table skeleton with the real column names,
 * edge to edge in the list card and stacked cards below 640px, as the table
 * renders. The time, event, summary and payload cells are two lines tall
 * (dual timestamp, label + raw code, wrapping summary, payload pairs), so
 * they draw two bars and the shell does not shift when the rows land.
 */
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';

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
    <DataTableSkeleton
      label={labels.caption}
      rows={8}
      columns={[
        { key: 'time', label: labels.time, skeletonLines: 2 },
        { key: 'event', label: labels.event, skeletonLines: 2, card: 'title' },
        { key: 'actor', label: labels.actor, skeletonLines: 2 },
        { key: 'target', label: labels.target },
        { key: 'summary', label: labels.summary, skeletonLines: 2 },
        { key: 'payload', label: labels.payload, skeletonLines: 2 },
      ]}
    />
  );
}
