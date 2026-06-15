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
import { Clock, AlertCircle } from 'lucide-react';
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
  /**
   * Type-3 (round-3) — single nullable struct so `(label, variant)`
   * cannot drift apart. Null = no badge to render. Populated for
   * `submitted` rows ≥24 h old (Smart-3 / FR-013 SLA).
   */
  readonly ageBadge: {
    readonly label: string;
    readonly variant: 'amber' | 'red';
  } | null;
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
    readonly bulkClear: string;
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
              {row.ageBadge ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'inline-flex items-center gap-1 self-start text-xs',
                    row.ageBadge.variant === 'red'
                      ? 'border-destructive/40 bg-destructive-surface text-destructive'
                      : 'border-amber-400/40 bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
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

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 hook
  const table = useReactTable({
    data: rows as EnrichedQueueRow[],
    columns,
    state: { rowSelection },
    enableRowSelection: (row) => row.original.actionable,
    onRowSelectionChange: setRowSelection,
    // Round-4 HIGH-G — stable row id keyed on broadcastId so the
    // failed-rows-stay-selected guarantee survives data refresh /
    // reorder. Without this, TanStack defaults to the row index and
    // selection points to wrong rows after `router.refresh()`.
    getRowId: (row) => row.broadcastId,
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

  // Smart-2 — bulk-approve handler. Concurrency capped at BULK_CHUNK
  // to avoid DB pool exhaustion on Neon serverless (~10 connections);
  // each approve takes a `lockForUpdate` advisory lock + tx.
  // Per-row failures are kept selected so the admin can retry without
  // re-selecting (IMP-2 round-3).
  const BULK_CHUNK = 5;
  // Simplify-S3 (round-3) — derive in render; no useMemo + ESLint
  // suppression. Selection size is bounded by visible rows; cost is
  // negligible.
  const selectedRows = table.getSelectedRowModel().rows;
  const selectedIds = selectedRows.map((r) => r.original.broadcastId);

  const handleBulkApprove = (): void => {
    if (selectedIds.length === 0 || pending) return;
    startTransition(async () => {
      type Outcome =
        | { id: string; subject: string; ok: true }
        | {
            id: string;
            subject: string;
            ok: false;
            status: number;
            code: string | null;
          };
      const outcomes: Outcome[] = [];

      // IMP-1 round-3 — chunked Promise.allSettled. Each chunk awaits
      // before the next so we never exceed BULK_CHUNK concurrent
      // requests against the approve endpoint.
      for (let i = 0; i < selectedRows.length; i += BULK_CHUNK) {
        const chunk = selectedRows.slice(i, i + BULK_CHUNK);
        const settled = await Promise.allSettled(
          chunk.map(async (r) => {
            const res = await fetch(
              `/api/admin/broadcasts/${r.original.broadcastId}/approve`,
              {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision: 'send_now' }),
              },
            );
            return { res, original: r.original };
          }),
        );
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            const { res, original } = result.value;
            if (res.ok) {
              outcomes.push({
                id: original.broadcastId,
                subject: original.subject,
                ok: true,
              });
            } else {
              // Round-5 R5-S4 — parse the F7 error envelope so the
              // partial-failure toast description carries the route's
              // `error.code` (e.g. `broadcast_concurrent_action_blocked`)
              // instead of just the opaque HTTP status. Admin can self-
              // diagnose without opening dev-tools.
              const body = await res
                .json()
                .catch(() => null) as { error?: { code?: string } } | null;
              outcomes.push({
                id: original.broadcastId,
                subject: original.subject,
                ok: false,
                status: res.status,
                code: body?.error?.code ?? null,
              });
            }
          } else {
            // Network failure — id from chunk position
            const idx = settled.indexOf(result);
            const original = chunk[idx]?.original;
            if (original) {
              outcomes.push({
                id: original.broadcastId,
                subject: original.subject,
                ok: false,
                status: 0,
                code: null,
              });
            }
          }
        }
      }

      const failures = outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok);
      const succeeded = outcomes.length - failures.length;

      if (failures.length === 0) {
        toast.success(columnLabels.bulkSuccess);
        setRowSelection({});
      } else if (succeeded === 0) {
        toast.error(columnLabels.bulkFailure, {
          description: failures
            .slice(0, 3)
            .map((f) => `${f.subject} (${f.code ?? (f.status === 0 ? 'network' : f.status)})`)
            .join(', '),
        });
        // Keep failed rows selected so admin can retry without re-selecting
      } else {
        toast.warning(
          columnLabels.bulkPartial
            .replace('{ok}', String(succeeded))
            .replace('{fail}', String(failures.length)),
          {
            description: failures
              .slice(0, 3)
              .map((f) => `${f.subject} (${f.code ?? (f.status === 0 ? 'network' : f.status)})`)
              .join(', '),
          },
        );
        // Clear successful rows; keep failures selected. With
        // `getRowId: row => row.broadcastId`, row.id === broadcastId so
        // the mapping is direct.
        const nextSelection: RowSelectionState = {};
        for (const f of failures) nextSelection[f.id] = true;
        setRowSelection(nextSelection);
      }
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

  // UX-R2-5 (round-3) + Round-4 CRIT-D — sticky bar uses the staff
  // shell's `--top-bar-height` CSS variable (defined globally and
  // applied at `src/app/(staff)/admin/layout.tsx` header). The bar sits
  // BELOW the shell header rather than under it. Falls back to 0px in
  // portal contexts where the variable isn't defined.
  // A5 UX hardening — bulk-bar `aria-label` was the unresolved template
  // string `"{count} selected"`; SR users heard the literal placeholder.
  // Interpolate the count before passing as label.
  const bulkSelectedLabel = columnLabels.bulkSelected.replace(
    '{count}',
    String(selectedIds.length),
  );
  const bulkBar =
    !readOnly && selectedIds.length > 0 ? (
      <div
        role="region"
        aria-label={bulkSelectedLabel}
        className="sticky z-20 mb-2 flex items-center justify-between gap-3 rounded-md border bg-primary/5 px-3 py-2"
        style={{ top: 'var(--top-bar-height, 0px)' }}
      >
        <span className="text-sm font-medium">{bulkSelectedLabel}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRowSelection({})}
            disabled={pending}
          >
            {columnLabels.bulkClear}
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

  // A6 UX hardening — padding-row virtualisation preserves the
  // `<table>/<tr>/<td>` DOM so screen readers in table-grid mode can
  // still navigate by row/column. Previously the virtualised path
  // used `position: absolute` on each `<tr>`, which breaks the
  // browser's table-layout algorithm and silently degrades SR
  // navigation. The TanStack docs recommend the padding-row pattern
  // for table virtualisation.
  //
  // Strategy: compute the unrendered space above the first visible
  // row + below the last visible row, and emit two `<tr>` spacer
  // rows holding that space via explicit `height` styles. The
  // visible `<tr>`s sit between them with normal flow layout.
  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();
  const paddingTop = virtualItems.length > 0 ? (virtualItems[0]?.start ?? 0) : 0;
  const lastItem = virtualItems[virtualItems.length - 1];
  const paddingBottom =
    virtualItems.length > 0 && lastItem !== undefined
      ? totalSize - lastItem.end
      : 0;
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
          <tbody>
            {paddingTop > 0 ? (
              <tr aria-hidden="true">
                <td style={{ height: `${paddingTop}px` }} />
              </tr>
            ) : null}
            {virtualItems.map((vRow) => {
              const row = rowModel.rows[vRow.index];
              if (!row) return null;
              return (
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
              );
            })}
            {paddingBottom > 0 ? (
              <tr aria-hidden="true">
                <td style={{ height: `${paddingBottom}px` }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}
