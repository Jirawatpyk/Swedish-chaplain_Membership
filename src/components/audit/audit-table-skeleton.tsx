/**
 * Skeleton for the read-only <AuditTable> (F9 US2).
 *
 * The real table is AURA's static `Table`, which sizes its columns to the
 * content, so the skeleton is AURA's `TableSkeleton` (5.52, #164) with each
 * column's share of the real one at a 1440px window: the columns sit where
 * the real ones land at any width, edge to edge in the card and stacked into
 * cards below 640px. Time, event, actor, summary and the payload pairs are
 * two lines (dual timestamp, label + raw code, name + role, wrapping summary,
 * the first pairs). `aria-hidden` and `inert`: the route announces the load.
 */
import { TableSkeleton } from '@jirawatpyk/aura-react/server';

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
    <TableSkeleton
      rows={8}
      stackBelow="sm"
      stackStyle="cards"
      align="middle"
      bleed
      columns={[
        { label: labels.time, width: '19%', skeleton: { lines: 2 } },
        { label: labels.event, width: '22%', card: 'title', skeleton: { lines: 2 } },
        { label: labels.actor, width: '9%', skeleton: { lines: 2 } },
        { label: labels.target, width: '17%' },
        { label: labels.summary, width: '17%', skeleton: { lines: 2 } },
        { label: labels.payload, width: '16%', skeleton: { lines: 2 } },
      ]}
    />
  );
}
