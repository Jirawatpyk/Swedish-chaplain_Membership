'use client';

/**
 * T117 — TanStack Table v8 client renderer with `@tanstack/react-virtual`
 * row virtualization. Activates virtualization automatically when row
 * count exceeds 100 (perf.md CHK039).
 *
 * The parent server component pre-formats every i18n + date-formatted
 * string so this client component never needs to call `getTranslations`
 * or hold a locale instance — keeps the bundle small and SSR-friendly.
 */
import { useMemo, useRef } from 'react';
import Link from 'next/link';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ReviewActions } from './review-actions';

const VIRTUALIZE_THRESHOLD = 100;
const ESTIMATED_ROW_HEIGHT_PX = 56;

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost';

export interface EnrichedQueueRow {
  readonly broadcastId: string;
  readonly subject: string;
  readonly memberDisplayName: string;
  readonly actorRoleLabel: string | null;
  readonly segmentLabel: string;
  readonly recipientCount: number;
  readonly submittedAtFormatted: string;
  readonly statusBadgeVariant: BadgeVariant;
  readonly statusBadgeClassName?: string;
  readonly statusBadgeLabel: string;
  readonly actionable: boolean;
}

export interface QueueTableClientProps {
  readonly rows: ReadonlyArray<EnrichedQueueRow>;
  readonly columnLabels: {
    readonly submittedAt: string;
    readonly member: string;
    readonly subject: string;
    readonly segment: string;
    readonly recipientCount: string;
    readonly status: string;
    readonly actions: string;
  };
  readonly readOnly?: boolean;
}

export function QueueTableClient({
  rows,
  columnLabels,
  readOnly = false,
}: QueueTableClientProps): React.ReactElement {
  const columns = useMemo<ColumnDef<EnrichedQueueRow>[]>(() => {
    const base: ColumnDef<EnrichedQueueRow>[] = [
      {
        id: 'submittedAt',
        header: columnLabels.submittedAt,
        accessorKey: 'submittedAtFormatted',
        cell: (ctx) => (
          <span className="text-muted-foreground tabular-nums">
            {ctx.getValue<string>()}
          </span>
        ),
      },
      {
        id: 'member',
        header: columnLabels.member,
        accessorKey: 'memberDisplayName',
        cell: (ctx) => (
          <div className="flex flex-col">
            <span className="font-medium">{ctx.row.original.memberDisplayName}</span>
            {ctx.row.original.actorRoleLabel ? (
              <span className="text-xs text-muted-foreground">
                {ctx.row.original.actorRoleLabel}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'subject',
        header: columnLabels.subject,
        accessorKey: 'subject',
        cell: (ctx) => (
          <Link
            href={`/admin/broadcasts/${ctx.row.original.broadcastId}`}
            className="font-medium text-primary hover:underline"
          >
            {ctx.row.original.subject}
          </Link>
        ),
      },
      {
        id: 'segment',
        header: columnLabels.segment,
        accessorKey: 'segmentLabel',
        cell: (ctx) => (
          <span className="text-muted-foreground">{ctx.getValue<string>()}</span>
        ),
      },
      {
        id: 'recipientCount',
        header: columnLabels.recipientCount,
        accessorKey: 'recipientCount',
        cell: (ctx) => (
          <span className="tabular-nums">{ctx.getValue<number>()}</span>
        ),
      },
      {
        id: 'status',
        header: columnLabels.status,
        cell: (ctx) => (
          <Badge
            variant={ctx.row.original.statusBadgeVariant}
            className={cn(ctx.row.original.statusBadgeClassName)}
          >
            {ctx.row.original.statusBadgeLabel}
          </Badge>
        ),
      },
    ];
    if (!readOnly) {
      base.push({
        id: 'actions',
        header: columnLabels.actions,
        cell: (ctx) =>
          ctx.row.original.actionable ? (
            <ReviewActions broadcastId={ctx.row.original.broadcastId} />
          ) : null,
      });
    }
    return base;
  }, [columnLabels, readOnly]);

  const table = useReactTable({
    data: rows as EnrichedQueueRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const shouldVirtualize = rows.length > VIRTUALIZE_THRESHOLD;
  const tableRef = useRef<HTMLDivElement>(null);
  const rowModel = table.getRowModel();
  const virtualizer = useVirtualizer({
    count: rowModel.rows.length,
    getScrollElement: () => tableRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT_PX,
    overscan: 8,
    enabled: shouldVirtualize,
  });

  const headerRow = (
    <tr>
      {table.getHeaderGroups()[0]?.headers.map((header, idx) => {
        const alignRight = header.column.id === 'recipientCount';
        return (
          <th
            key={header.id}
            scope="col"
            className={`px-3 py-2 ${alignRight ? 'text-right' : 'text-left'}`}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </th>
        );
      })}
    </tr>
  );

  if (!shouldVirtualize) {
    return (
      <div className="overflow-x-auto rounded-md border" ref={tableRef}>
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide">
            {headerRow}
          </thead>
          <tbody>
            {rowModel.rows.map((row) => (
              <tr key={row.id} className="border-t">
                {row.getVisibleCells().map((cell) => {
                  const alignRight = cell.column.id === 'recipientCount';
                  return (
                    <td
                      key={cell.id}
                      className={`px-3 py-2 ${alignRight ? 'text-right' : ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Virtualized variant: render only visible rows inside a fixed-height
  // scroll container (perf.md CHK039 — keeps DOM ≤ 8 rows even with
  // thousands of broadcasts).
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  return (
    <div
      className="overflow-auto rounded-md border"
      style={{ height: '70vh', maxHeight: '720px' }}
      ref={tableRef}
      role="region"
      aria-label="Broadcast queue (virtualized)"
    >
      <table className="w-full min-w-[920px] text-sm">
        <thead className="sticky top-0 z-10 bg-muted/95 text-xs uppercase tracking-wide backdrop-blur">
          {headerRow}
        </thead>
        <tbody style={{ height: `${totalSize}px`, position: 'relative' }}>
          {virtualItems.map((vRow) => {
            const row = rowModel.rows[vRow.index];
            if (!row) return null;
            return (
              <tr
                key={row.id}
                className="absolute left-0 right-0 border-t"
                style={{ transform: `translateY(${vRow.start}px)` }}
              >
                {row.getVisibleCells().map((cell) => {
                  const alignRight = cell.column.id === 'recipientCount';
                  return (
                    <td
                      key={cell.id}
                      className={`px-3 py-2 ${alignRight ? 'text-right' : ''}`}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
