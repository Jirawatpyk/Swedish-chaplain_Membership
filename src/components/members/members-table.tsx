'use client';

/**
 * T065 + T108 + T112 — Members directory table.
 *
 * TanStack Table v8 headless + shadcn Table visual primitives. Rows link
 * to the detail page. Reserves the `member_risk_flag` column for F8 —
 * rendered as a placeholder em-dash per FR-001 note + US2 AS5.
 *
 * T108 (US4): Row-selection state via TanStack Table enableRowSelection +
 * Shift+Click range + Space toggle + Ctrl+A page-select + "Select all N
 * matching" (FR-040). Selection is hidden for non-admin roles.
 *
 * T112 (US4): Inline-edit cells for status/country/notes with
 * aria-live save/rollback announcements + 24×24 min target size
 * (ADOPT-01 / WCAG 2.2 SC 2.5.8).
 *
 * Pagination is cursor-based at the server level; this component exposes
 * a "Load more" button that the parent wires to re-fetch with the echoed
 * cursor.
 */

import { useState, useCallback, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  useReactTable,
  getCoreRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  type RowSelectionState,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';

export type MembersTableRow = {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly plan_id: string;
  readonly plan_year: number;
  /**
   * English display name of the plan, resolved at the SQL layer via a
   * correlated subquery in searchDirectory. Null when the plan row is
   * missing (defensive fallback — the table renders the slug).
   */
  readonly plan_display_name: string | null;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly member_risk_flag: null;
  readonly last_activity_at: string | null;
  readonly primary_contact: {
    readonly contact_id: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly email: string;
  } | null;
};

type Props = {
  readonly rows: readonly MembersTableRow[];
  readonly nextCursor: string | null;
  /** Admin-only: enable multi-row selection + inline edit. */
  readonly enableSelection?: boolean | undefined;
  /** Callback when selection changes — used by BulkActionBar. */
  readonly onSelectionChange?: ((selectedIds: string[]) => void) | undefined;
  /** Callback for inline-edit save. */
  readonly onInlineEdit?: ((
    memberId: string,
    field: 'status' | 'country' | 'notes',
    value: string | null,
  ) => Promise<{ ok: boolean; error?: string }>) | undefined;
};

const columnHelper = createColumnHelper<MembersTableRow>();

function StatusBadge({ status }: { status: MembersTableRow['status'] }) {
  const t = useTranslations('admin.members.directory');
  const label =
    status === 'active'
      ? t('statusActive')
      : status === 'inactive'
        ? t('statusInactive')
        : t('statusArchived');
  const variant: 'default' | 'secondary' | 'outline' =
    status === 'active'
      ? 'default'
      : status === 'inactive'
        ? 'secondary'
        : 'outline';
  return <Badge variant={variant}>{label}</Badge>;
}

/** T112 — Inline-editable status cell. */
function InlineStatusCell({
  memberId,
  status,
  onSave,
}: {
  memberId: string;
  status: MembersTableRow['status'];
  onSave?: Props['onInlineEdit'];
}) {
  const t = useTranslations('admin.members.inlineEdit');
  const [saving, setSaving] = useState(false);
  const [optimistic, setOptimistic] = useState(status);

  const handleToggle = useCallback(async () => {
    if (!onSave || status === 'archived') return;
    const next = optimistic === 'active' ? 'inactive' : 'active';
    setOptimistic(next);
    setSaving(true);
    const result = await onSave(memberId, 'status', next);
    setSaving(false);
    if (result.ok) {
      toast.success(t('statusUpdated'));
    } else {
      setOptimistic(status); // rollback
      toast.error(result.error ?? t('saveFailed'));
    }
  }, [memberId, status, optimistic, onSave, t]);

  if (!onSave || status === 'archived') {
    return <StatusBadge status={status} />;
  }

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={saving}
      className="min-h-[24px] min-w-[24px] rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('toggleStatus', { current: optimistic })}
    >
      <StatusBadge status={optimistic} />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : ''}
      </span>
    </button>
  );
}

export function MembersTable({
  rows,
  nextCursor,
  enableSelection = false,
  onSelectionChange,
  onInlineEdit,
}: Props) {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const lastSelectedRef = useRef<number | null>(null);

  const handleRowSelectionChange = useCallback(
    (updater: RowSelectionState | ((old: RowSelectionState) => RowSelectionState)) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      setRowSelection(next);
      if (onSelectionChange) {
        // With getRowId set to member_id, keys in RowSelectionState
        // ARE member_ids directly (not numeric indices).
        const selectedIds = Object.keys(next).filter((k) => next[k]);
        onSelectionChange(selectedIds);
      }
    },
    [rowSelection, onSelectionChange],
  );

  const columns = [
    ...(enableSelection
      ? [
          columnHelper.display({
            id: 'select',
            header: ({ table }) => (
              <Checkbox
                checked={table.getIsAllPageRowsSelected()}
                onCheckedChange={(checked) =>
                  table.toggleAllPageRowsSelected(!!checked)
                }
                aria-label={t('selectAll')}
                className="min-h-[24px] min-w-[24px]"
              />
            ),
            cell: ({ row }) => (
              <Checkbox
                checked={row.getIsSelected()}
                onCheckedChange={(checked) => row.toggleSelected(!!checked)}
                onClick={(e: React.MouseEvent) => {
                  // Shift+Click range selection (FR-040)
                  if (e.shiftKey && lastSelectedRef.current !== null) {
                    const start = Math.min(lastSelectedRef.current, row.index);
                    const end = Math.max(lastSelectedRef.current, row.index);
                    const next = { ...rowSelection };
                    for (let i = start; i <= end; i++) {
                      // getRowId uses member_id, so key by member_id
                      const memberId = rows[i]?.member_id;
                      if (memberId) next[memberId] = true;
                    }
                    handleRowSelectionChange(next);
                    e.preventDefault();
                    return;
                  }
                  lastSelectedRef.current = row.index;
                }}
                aria-label={t('selectRow', {
                  company: row.original.company_name,
                })}
                className="min-h-[24px] min-w-[24px]"
              />
            ),
            size: 40,
          }),
        ]
      : []),
    columnHelper.accessor('company_name', {
      header: () => t('columns.company'),
      cell: (info) => (
        <span className="font-medium">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor('country', {
      header: () => t('columns.country'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('plan_display_name', {
      header: () => t('columns.plan'),
      cell: (info) => {
        const displayName = info.getValue();
        const row = info.row.original;
        const label = displayName ?? row.plan_id;
        return (
          <span title={row.plan_id} className="text-sm">
            {label}
          </span>
        );
      },
    }),
    columnHelper.accessor('plan_year', {
      header: () => t('columns.year'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('primary_contact', {
      header: () => t('columns.primaryContact'),
      cell: (info) => {
        const c = info.getValue();
        if (!c) return <span className="text-muted-foreground">{t('noPrimary')}</span>;
        return (
          <div className="flex flex-col">
            <span>{`${c.first_name} ${c.last_name}`.trim()}</span>
            <span className="text-xs text-muted-foreground">{c.email}</span>
          </div>
        );
      },
    }),
    columnHelper.accessor('status', {
      header: () => t('columns.status'),
      cell: (info) =>
        enableSelection ? (
          <InlineStatusCell
            memberId={info.row.original.member_id}
            status={info.getValue()}
            onSave={onInlineEdit}
          />
        ) : (
          <StatusBadge status={info.getValue()} />
        ),
    }),
    columnHelper.accessor('member_risk_flag', {
      header: () => t('columns.risk'),
      cell: () => (
        <span className="text-muted-foreground" aria-label="placeholder">
          {t('riskPlaceholder')}
        </span>
      ),
    }),
    columnHelper.accessor('last_activity_at', {
      header: () => t('columns.lastActivity'),
      cell: (info) => {
        const v = info.getValue();
        if (!v) return <span className="text-muted-foreground">—</span>;
        return v.slice(0, 10);
      },
    }),
  ];

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows as MembersTableRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableRowSelection: enableSelection,
    onRowSelectionChange: handleRowSelectionChange,
    state: {
      rowSelection,
    },
    getRowId: (row) => row.member_id,
  });

  const onLoadMore = () => {
    if (!nextCursor) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('cursor', nextCursor);
    router.replace(`${pathname}?${params.toString()}`);
  };

  const selectedCount = Object.keys(rowSelection).filter(
    (k) => rowSelection[k],
  ).length;

  return (
    <div className="flex flex-col gap-4">
      {enableSelection && selectedCount > 0 && (
        <div
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {t('selectedCount', { count: selectedCount })}
        </div>
      )}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const m = row.original;
              return (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  className={`cursor-pointer hover:bg-accent/40 focus-within:bg-accent/40 ${
                    row.getIsSelected() ? 'bg-accent/20' : ''
                  }`}
                >
                  {row.getVisibleCells().map((cell, idx) => (
                    <TableCell key={cell.id} className="align-top">
                      {/* First non-select column is the company name link */}
                      {!enableSelection && idx === 0 ? (
                        <Link
                          href={`/admin/members/${m.member_id}`}
                          aria-label={t('rowAriaLabel', { company: m.company_name })}
                          className="focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </Link>
                      ) : enableSelection && idx === 1 ? (
                        <Link
                          href={`/admin/members/${m.member_id}`}
                          aria-label={t('rowAriaLabel', { company: m.company_name })}
                          className="focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </Link>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Export for BulkActionBar to read the current selection count. */
export { type RowSelectionState };
