'use client';

/**
 * T117 — TanStack Table v8 client renderer with `@tanstack/react-virtual`
 * row virtualization. Activates virtualization automatically when row
 * count exceeds 100 (perf.md CHK039).
 *
 * Smart-2 (2026-04-30): admins can multi-select `submitted` rows and
 * bulk-approve in one click via Promise.allSettled (catalogue Feature #7).
 *
 * The parent server component pre-formats every i18n + date-formatted
 * string so this client component never needs to call `getTranslations`
 * or hold a locale instance — keeps the bundle small and SSR-friendly.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
  readonly ageBadgeLabel: string | null;
  readonly ageBadgeVariant: 'amber' | 'red' | null;
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
    readonly select: string;
    readonly bulkApprove: string;
    readonly bulkSelected: string;
    readonly bulkSuccess: string;
    readonly bulkFailure: string;
    readonly bulkPartial: string;
    readonly tableAria: string;
  };
  readonly readOnly?: boolean;
}

export function QueueTableClient({
  rows,
  columnLabels,
  readOnly = false,
}: QueueTableClientProps): React.ReactElement {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const columns = useMemo<ColumnDef<EnrichedQueueRow>[]>(() => {
    const base: ColumnDef<EnrichedQueueRow>[] = [];

    // Smart-2: row-selection checkbox (admin only). Manager (`readOnly`)
    // never sees the column so the bulk-action surface is invisible to
    // read-only roles.
    if (!readOnly) {
      base.push({
        id: 'select',
        header: ({ table }) => {
          const actionableRows = table
            .getRowModel()
            .rows.filter((r) => r.original.actionable);
          const allSelected =
            actionableRows.length > 0 &&
            actionableRows.every((r) => r.getIsSelected());
          return (
            <Checkbox
              aria-label={columnLabels.select}
              checked={allSelected}
              onCheckedChange={(checked) => {
                actionableRows.forEach((r) => r.toggleSelected(Boolean(checked)));
              }}
            />
          );
        },
        cell: (ctx) =>
          ctx.row.original.actionable ? (
            <Checkbox
              aria-label={columnLabels.select}
              checked={ctx.row.getIsSelected()}
              onCheckedChange={(checked) => ctx.row.toggleSelected(Boolean(checked))}
            />
          ) : null,
      });
    }

    base.push(
      {
        id: 'submittedAt',
        header: columnLabels.submittedAt,
        accessorKey: 'submittedAtFormatted',
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <div className="flex flex-col gap-0.5">
              <span className="text-muted-foreground tabular-nums">
                {row.submittedAtFormatted}
              </span>
              {row.ageBadgeLabel ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'self-start text-xs',
                    row.ageBadgeVariant === 'red'
                      ? 'border-destructive/40 bg-destructive/10 text-destructive'
                      : 'border-amber-400/40 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
                  )}
                >
                  {row.ageBadgeLabel}
                </Badge>
              ) : null}
            </div>
          );
        },
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
    );
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
    state: { rowSelection },
    enableRowSelection: (row) => row.original.actionable,
    onRowSelectionChange: setRowSelection,
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

  // Smart-2 — bulk-approve handler. Promise.allSettled keeps a single
  // 5xx from blocking the rest. Toast summarises success/partial/total
  // failure; router.refresh() re-fetches the queue rows from the server.
  const selectedIds = useMemo(
    () =>
      table
        .getSelectedRowModel()
        .rows.map((r) => r.original.broadcastId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowSelection],
  );

  const handleBulkApprove = (): void => {
    if (selectedIds.length === 0 || pending) return;
    startTransition(async () => {
      const results = await Promise.allSettled(
        selectedIds.map((id) =>
          fetch(`/api/admin/broadcasts/${id}/approve`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'send_now' }),
          }).then(async (res) => {
            if (!res.ok) throw new Error(`status ${res.status}`);
            return id;
          }),
        ),
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - succeeded;
      if (failed === 0) {
        toast.success(columnLabels.bulkSuccess);
      } else if (succeeded === 0) {
        toast.error(columnLabels.bulkFailure);
      } else {
        toast.warning(columnLabels.bulkPartial.replace('{ok}', String(succeeded)).replace('{fail}', String(failed)));
      }
      setRowSelection({});
      router.refresh();
    });
  };

  const headerRow = (
    <tr>
      {table.getHeaderGroups()[0]?.headers.map((header) => {
        const alignRight = header.column.id === 'recipientCount';
        const narrow = header.column.id === 'select';
        return (
          <th
            key={header.id}
            scope="col"
            className={cn(
              'px-3 py-2',
              alignRight && 'text-right',
              !alignRight && !narrow && 'text-left',
              narrow && 'w-10',
            )}
          >
            {flexRender(header.column.columnDef.header, header.getContext())}
          </th>
        );
      })}
    </tr>
  );

  const bulkBar = !readOnly && selectedIds.length > 0 ? (
    <div
      role="region"
      aria-label={columnLabels.bulkSelected}
      className="sticky top-0 z-20 mb-2 flex items-center justify-between gap-3 rounded-md border bg-primary/5 px-3 py-2"
    >
      <span className="text-sm font-medium">
        {columnLabels.bulkSelected.replace('{count}', String(selectedIds.length))}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setRowSelection({})}
          disabled={pending}
        >
          {columnLabels.actions}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={handleBulkApprove}
          disabled={pending}
        >
          {columnLabels.bulkApprove}
        </Button>
      </div>
    </div>
  ) : null;

  if (!shouldVirtualize) {
    return (
      <>
        {bulkBar}
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
      </>
    );
  }

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  return (
    <>
      {bulkBar}
      <div
        className="overflow-auto rounded-md border"
        style={{ height: '70vh', maxHeight: '720px' }}
        ref={tableRef}
        role="region"
        aria-label={columnLabels.tableAria}
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
    </>
  );
}
