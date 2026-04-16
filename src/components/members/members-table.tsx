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

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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
import { PencilIcon } from 'lucide-react';
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
  /** Admin-only inline-edit target (FR-040). Visible in the Notes cell. */
  readonly notes: string | null;
  readonly primary_contact: {
    readonly contact_id: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly email: string;
  } | null;
};

// Round-2 review I-7: InlineEditResult is a discriminated union so
// `error: string` is required when `ok: false` — avoids the
// `error?: string` bug under exactOptionalPropertyTypes (which would
// accept `{ ok: false, error: undefined }` and mask missing messages).
export type InlineEditResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

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
  ) => Promise<InlineEditResult>) | undefined;
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

  // Round-2 review I-4: sync optimistic state when the `status` prop
  // changes (e.g. after router.refresh() following a bulk action while
  // the cell is still mounted). Without this, optimistic stays stale.
  useEffect(() => {
    setOptimistic(status);
  }, [status]);

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
      // Discriminated union — `error` is guaranteed string when !ok.
      toast.error(result.error);
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
      title={t('toggleStatus', { current: optimistic })}
      className="group inline-flex min-h-[28px] min-w-[60px] cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-wait disabled:opacity-60"
      aria-label={t('toggleStatus', { current: optimistic })}
    >
      <StatusBadge status={optimistic} />
      <PencilIcon
        className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        aria-hidden="true"
      />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : ''}
      </span>
    </button>
  );
}

/**
 * T112 — Inline-editable country cell.
 *
 * Double-click the flag/code to enter edit mode. The admin types a new
 * ISO 3166-1 alpha-2 code (2 letters). Save on Enter or blur; rollback
 * on Escape. Server-side value-object validation rejects invalid codes.
 */
function InlineCountryCell({
  memberId,
  country,
  onSave,
}: {
  memberId: string;
  country: string;
  onSave?: Props['onInlineEdit'];
}) {
  const t = useTranslations('admin.members.inlineEdit');
  // `editing` is `null` when not editing; holds the draft value while editing.
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Round-4 review R4-I1: `saving` state update is async — if user presses
  // Enter then blur fires immediately, both handlers read `saving=false`
  // and submit twice. A ref is synchronous so a second concurrent call
  // short-circuits before the DB roundtrip.
  const savingRef = useRef(false);
  // Staff-review SW-6: Escape+blur race — when user presses Escape, the
  // input unmounts and some browsers fire a blur event before unmount,
  // triggering handleSave with the stale closure. A sync cancelling flag
  // lets the Escape branch short-circuit the queued blur's handleSave.
  const cancellingRef = useRef(false);

  const handleSave = useCallback(async () => {
    if (cancellingRef.current || !onSave || editing === null || savingRef.current) return;
    savingRef.current = true;
    try {
      const normalised = editing.trim().toUpperCase();
      if (normalised === country) {
        setEditing(null);
        return;
      }
      if (normalised.length !== 2) {
        toast.error(t('countryInvalid'));
        setEditing(null);
        return;
      }
      setSaving(true);
      const result = await onSave(memberId, 'country', normalised);
      setSaving(false);
      if (result.ok) {
        toast.success(t('countryUpdated'));
        setEditing(null);
      } else {
        // Round-3 review N-I1: keep input open on error so user can retry
        // without retyping. Toast announces the failure; they can Escape to
        // cancel or fix + retry.
        toast.error(result.error);
      }
    } finally {
      savingRef.current = false;
    }
  }, [memberId, country, editing, onSave, t]);

  // Round-3 N-I6: focus via useEffect on editing state change — more
  // reliable than requestAnimationFrame under React 19 concurrent rendering.
  useEffect(() => {
    if (editing !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (!onSave) {
    return <span>{country}</span>;
  }

  if (editing === null) {
    return (
      <button
        type="button"
        onDoubleClick={() => setEditing(country)}
        title={t('editCountryHint')}
        className="group inline-flex min-h-[28px] min-w-[40px] cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('editCountry')}
      >
        <span>{country}</span>
        <PencilIcon
          className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="text"
        value={editing}
        maxLength={2}
        pattern="[A-Za-z]{2}"
        onChange={(e) => setEditing(e.target.value.toUpperCase())}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // Staff-review SW-6: set sync flag BEFORE clearing state so
            // any queued blur-triggered handleSave short-circuits.
            cancellingRef.current = true;
            setEditing(null);
            // Reset the flag on next tick — by then the blur has flushed
            // and any subsequent enter-edit-mode cycle starts clean.
            queueMicrotask(() => {
              cancellingRef.current = false;
            });
          }
        }}
        disabled={saving}
        className="h-7 w-14 rounded-sm border border-input bg-background px-2 text-sm uppercase focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('countryInput')}
      />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : ''}
      </span>
    </div>
  );
}

/**
 * T112 — Inline-editable notes cell.
 *
 * Double-click to enter edit mode (textarea). Blur or Enter saves;
 * Escape cancels. Content truncated to a short preview in display mode.
 * Notes content is NOT in the audit diff for privacy — only the
 * `fields_changed: ['notes']` marker is logged.
 */
function InlineNotesCell({
  memberId,
  notes,
  onSave,
}: {
  memberId: string;
  notes: string | null;
  onSave?: Props['onInlineEdit'];
}) {
  const t = useTranslations('admin.members.inlineEdit');
  // `editing` is `null` when not editing; holds the draft value while editing.
  // Storing the draft separately from the prop avoids the prop/state sync
  // problem — when the admin enters edit mode we snapshot `notes` into the
  // draft. On cancel/save we go back to reading `notes` directly.
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Round-4 R4-I1: sync guard against onBlur + Enter double-fire race.
  const savingRef = useRef(false);
  // Staff-review SW-6: sync guard against Escape+blur draft loss.
  const cancellingRef = useRef(false);

  const handleSave = useCallback(async () => {
    if (cancellingRef.current || !onSave || editing === null || savingRef.current) return;
    savingRef.current = true;
    try {
      const next = editing.trim() || null;
      if (next === notes) {
        setEditing(null);
        return;
      }
      setSaving(true);
      const result = await onSave(memberId, 'notes', next);
      setSaving(false);
      if (result.ok) {
        toast.success(t('notesUpdated'));
        setEditing(null);
      } else {
        // Round-3 N-I1: keep textarea open so user doesn't lose their draft.
        toast.error(result.error);
      }
    } finally {
      savingRef.current = false;
    }
  }, [memberId, notes, editing, onSave, t]);

  // Round-3 N-I6: focus via useEffect on editing state change.
  useEffect(() => {
    if (editing !== null) {
      textareaRef.current?.focus();
    }
  }, [editing]);

  if (!onSave) {
    return (
      <span
        className="block max-w-[160px] truncate text-sm text-muted-foreground"
        title={notes ?? undefined}
      >
        {notes ?? '—'}
      </span>
    );
  }

  if (editing === null) {
    const preview = notes ? (notes.length > 24 ? notes.slice(0, 24) + '…' : notes) : '—';
    return (
      <button
        type="button"
        onDoubleClick={() => setEditing(notes ?? '')}
        title={notes ?? t('editNotesHint')}
        className="group inline-flex min-h-[28px] max-w-[180px] cursor-pointer items-center gap-1 truncate rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('editNotes')}
      >
        <span className="truncate">{preview}</span>
        <PencilIcon
          className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-hidden="true"
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <textarea
        ref={textareaRef}
        value={editing}
        maxLength={4000}
        rows={2}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={handleSave}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            // Staff-review SW-6: block queued-blur handleSave from the
            // stale closure before clearing state.
            cancellingRef.current = true;
            setEditing(null);
            queueMicrotask(() => {
              cancellingRef.current = false;
            });
          }
        }}
        disabled={saving}
        className="min-h-[28px] w-48 resize-y rounded-sm border border-input bg-background px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('notesInput')}
        placeholder={t('notesPlaceholder')}
      />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : ''}
      </span>
    </div>
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
  const tableContainerRef = useRef<HTMLDivElement>(null);

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

  // Round-6 W-2: memoize columns so TanStack Table v8 doesn't
  // trigger a full table reconciliation on every render.
  const columns = useMemo(() => [
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
      cell: (info) =>
        enableSelection ? (
          <InlineCountryCell
            memberId={info.row.original.member_id}
            country={info.getValue()}
            onSave={onInlineEdit}
          />
        ) : (
          info.getValue()
        ),
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
    columnHelper.accessor('notes', {
      header: () => t('columns.notes'),
      cell: (info) =>
        enableSelection ? (
          <InlineNotesCell
            memberId={info.row.original.member_id}
            notes={info.getValue()}
            onSave={onInlineEdit}
          />
        ) : (
          <span
            className="block max-w-[160px] truncate text-sm text-muted-foreground"
            title={info.getValue() ?? undefined}
          >
            {info.getValue() ?? '—'}
          </span>
        ),
    }),
  ], [enableSelection, onInlineEdit, t, rows, rowSelection, handleRowSelectionChange]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 hook
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

  const allPageSelected =
    enableSelection && rows.length > 0 && selectedCount === rows.length;
  const hasMorePages = enableSelection && nextCursor !== null;

  // Round-6 W-3: store table in a ref so the Ctrl+A effect has a stable
  // dependency (table object is rebuilt every render by useReactTable).
  const tableRef = useRef(table);
  tableRef.current = table;

  // Staff-review SW-4: Ctrl+A / Cmd+A within the table selects all rows
  // on the current page (FR-040). Scoped to the table container so the
  // shortcut doesn't conflict with browser-wide text selection outside.
  useEffect(() => {
    if (!enableSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        const active = document.activeElement;
        if (
          tableContainerRef.current &&
          (tableContainerRef.current.contains(active) ||
            active === document.body)
        ) {
          e.preventDefault();
          tableRef.current.toggleAllPageRowsSelected(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enableSelection]);

  return (
    <div className="flex flex-col gap-4" ref={tableContainerRef}>
      {enableSelection && selectedCount > 0 && (
        <div
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {t('selectedCount', { count: selectedCount })}
        </div>
      )}
      {/* Staff-review SW-4: "Select all N matching" affordance when the
          whole current page is selected AND more matching rows exist on
          subsequent pages. Clicking the text loads the next page — full
          cross-page ids batch-select requires an API endpoint (deferred). */}
      {allPageSelected && hasMorePages && (
        <div
          className="rounded-md border border-accent bg-accent/40 px-4 py-2 text-sm"
          role="status"
        >
          {t.rich('selectAllMatchingHint', {
            count: selectedCount,
            loadMore: (chunks) => (
              <button
                type="button"
                className="ml-2 font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  const params = new URLSearchParams(searchParams.toString());
                  if (nextCursor) params.set('cursor', nextCursor);
                  router.replace(`${pathname}?${params.toString()}`);
                }}
              >
                {chunks}
              </button>
            ),
          })}
        </div>
      )}
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
