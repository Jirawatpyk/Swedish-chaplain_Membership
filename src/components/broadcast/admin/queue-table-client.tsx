'use client';

/**
 * T117 — TanStack Table v8 client renderer.
 *
 * Task 2 (2026-08-01-broadcast-review-queue-pr2): row virtualization
 * (`@tanstack/react-virtual`, threshold 100 rows, perf.md CHK039) was
 * removed — the queue query pages at 50 rows, so the threshold never
 * fired in production. Dead code removed to unblock the shared `<Table>`
 * adoption (Task 3).
 *
 * Task 3 — the desktop table markup now renders through the shared
 * `@/components/ui/table.tsx` primitive (focusable `role="region"` scroll
 * container, sticky `bg-card` header, `--table-row-height` rows) instead
 * of a hand-rolled `<table>`, matching the members/renewals lists. Wrapped
 * in `hidden md:block` to prepare Task 4's mobile card dual-render (the
 * card list itself is out of scope here).
 *
 * Smart-2 (2026-04-30): admins can multi-select `submitted` rows and
 * bulk-approve in one click via Promise.allSettled (catalogue Feature #7).
 *
 * The parent server component pre-formats every per-row + column-header
 * i18n string and locale-formatted date, so this component never needs
 * `getTranslations` or a locale instance for row/column content. The
 * bulk-selection bar strings (`admin.broadcasts.queue.bulk.*`) are the one
 * exception — Task 5 moved those to client-side `useTranslations` so the
 * `bulk.selected` ICU-plural count interpolates correctly without a
 * `.replace()` template hack.
 */
import { useMemo, useState, useTransition } from 'react';
import { Clock, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { ReviewActions } from './review-actions';

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
  const tBulk = useTranslations('admin.broadcasts.queue.bulk');

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
          const selectedActionable = actionableRows.filter((r) => r.getIsSelected());
          const allSelected =
            actionableRows.length > 0 && selectedActionable.length === actionableRows.length;
          const someSelected = selectedActionable.length > 0 && !allSelected;
          return (
            <Checkbox
              aria-label={columnLabels.select}
              checked={allSelected}
              indeterminate={someSelected}
              className="min-h-[24px] min-w-[24px]"
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
              className="min-h-[24px] min-w-[24px]"
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
            <ReviewActions
              broadcastId={ctx.row.original.broadcastId}
              recipientCount={ctx.row.original.recipientCount}
            />
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

  const rowModel = table.getRowModel();

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
        toast.success(tBulk('successAll'));
        setRowSelection({});
      } else if (succeeded === 0) {
        toast.error(tBulk('failureAll'), {
          description: failures
            .slice(0, 3)
            .map((f) => `${f.subject} (${f.code ?? (f.status === 0 ? 'network' : f.status)})`)
            .join(', '),
        });
        // Keep failed rows selected so admin can retry without re-selecting
      } else {
        toast.warning(
          tBulk('partial', { ok: succeeded, fail: failures.length }),
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

  // UX-R2-5 (round-3) + Round-4 CRIT-D — sticky bar uses the staff
  // shell's `--top-bar-height` CSS variable (defined globally and
  // applied at `src/app/(staff)/admin/layout.tsx` header). The bar sits
  // BELOW the shell header rather than under it. Falls back to 0px in
  // portal contexts where the variable isn't defined.
  // A5 UX hardening — bulk-bar `aria-label` was the unresolved template
  // string `"{count} selected"`; SR users heard the literal placeholder.
  // Task 5 — moved to `tBulk('selected', {count})` (ICU plural) so the
  // count is both correctly interpolated AND grammatically pluralised.
  const bulkSelectedLabel = tBulk('selected', { count: selectedIds.length });
  // Round-2 review Fix 1 — the visible bar (and its `aria-live`) is
  // conditionally MOUNTED (`selectedIds.length > 0 ? (...) : null`), so an
  // `aria-live` region that appears WITH its content already populated in
  // the same paint is not reliably announced by NVDA/JAWS — only text
  // MUTATIONS on an already-mounted live region are announced. That silences
  // exactly the transitions this feature exists to announce: 0→1 (entering
  // selection) and 1→0 (clearing). Fix: a permanently-mounted sr-only
  // announcer rendered unconditionally below, separate from the visible bar.
  // Precedent: `members-table.tsx` selected-count region +
  // `renewals/result-count-announcer.tsx`.
  const selectionAnnouncement = selectedIds.length > 0 ? bulkSelectedLabel : '';
  const selectionAnnouncer = !readOnly ? (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {selectionAnnouncement}
    </div>
  ) : null;
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
            {tBulk('clear')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleBulkApprove}
            disabled={pending}
          >
            {tBulk('approveSelected')}
          </Button>
        </div>
      </div>
    ) : null;

  return (
    <>
      {selectionAnnouncer}
      {bulkBar}
      {/* Desktop only — Task 4 adds the mobile card dual-render below md. */}
      <div className="hidden md:block">
        <Table aria-label={columnLabels.tableAria}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const alignRight = header.column.id === 'recipientCount';
                  const narrow = header.column.id === 'select';
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      className={cn(alignRight && 'text-right', narrow && 'w-10')}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rowModel.rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                {row.getVisibleCells().map((cell) => {
                  const alignRight = cell.column.id === 'recipientCount';
                  // Review round 1, I-1 — `TableCell` applies `whitespace-nowrap`
                  // to every cell. `subject` is free-text up to ~200 chars (F7
                  // sanitiser cap) and the primary column admins scan; under
                  // table auto-layout an un-wrapped long subject widens the
                  // whole table past its container. Restore wrapping on this
                  // column only, capped so one very long word/subject can't
                  // still blow out the column width. Precedent:
                  // `members-table.tsx` "057 overflow fix" (`whitespace-normal
                  // break-words` replacing `whitespace-nowrap`).
                  const wrapSubject = cell.column.id === 'subject';
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        alignRight && 'text-right',
                        wrapSubject && 'max-w-[40ch] whitespace-normal break-words',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
