'use client';

/**
 * T065 + T108 + T112 — Members directory table.
 *
 * TanStack Table v8 headless + shadcn Table visual primitives. Rows link
 * to the detail page.
 *
 * 056-members-table-compact — Lean 8-column layout (was 12; the wide set
 * overflowed the page). Final columns:
 *   ☑ select │ Member No. │ Company (flag + name) │ Plan · Year │
 *   Contact (name only) │ Status │ Engagement │ Last Activity
 * Country moved into the Company cell as a leading flag (edited on the
 * member detail page). Plan + Year are merged with a middot. The Risk
 * column was dropped (Engagement is the positive-framed inverse of the
 * same F8 signal). Notes moved to the detail page. Inline edit now serves
 * Status only — the country/notes inline cells were removed.
 *
 * T108 (US4): Row-selection state via TanStack Table enableRowSelection +
 * Shift+Click range + Space toggle + Ctrl+A page-select + "Select all N
 * matching" (FR-040). Selection is hidden for non-admin roles.
 *
 * T112 (US4): Inline-edit Status cell with aria-live save/rollback
 * announcements + 24×24 min target size (ADOPT-01 / WCAG 2.2 SC 2.5.8).
 *
 * Pagination is cursor-based at the server level; this component exposes
 * a "Load more" button that the parent wires to re-fetch with the echoed
 * cursor.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { RelativeTime } from '@/components/ui/relative-time';
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  PencilIcon,
  PencilLineIcon,
} from 'lucide-react';
import { toast } from 'sonner';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the insights server graph). The engagement value is projected server-side.
import type { EngagementBand } from '@/modules/insights';
// C4 round-10 ui-design-specialist — flag emoji + localised country name.
// 056-members-table-compact — the flag now leads the Company cell.
import { CountryDisplay } from './country-display';

export type MembersTableRow = {
  readonly member_id: string;
  /**
   * Pre-formatted display string (`SCCM-0042`) computed server-side in the
   * page row-mapping via `formatMemberNumber(tenantPrefix, …)`. The raw
   * integer is intentionally NOT shipped to the client: the cell renders
   * this display string and sort is server-side via the `?sort=memberNumber`
   * URL param, so the wire payload stays one field lighter per row.
   */
  readonly member_number_display: string;
  readonly company_name: string;
  /**
   * ISO 3166-1 alpha-2 country code. 056-members-table-compact: rendered
   * as a leading flag inside the Company cell (no standalone column). Edited
   * on the member detail page, not inline.
   */
  readonly country: string;
  readonly plan_id: string;
  /**
   * 056-members-table-compact: merged with `plan_display_name` into a single
   * "Plan · Year" cell (no standalone Year column).
   */
  readonly plan_year: number;
  /**
   * English display name of the plan, resolved at the SQL layer via a
   * correlated subquery in searchDirectory. Null when the plan row is
   * missing (defensive fallback — the table renders the slug).
   */
  readonly plan_display_name: string | null;
  readonly status: 'active' | 'inactive' | 'archived';
  /**
   * F9 (T034 / G1) — engagement score = positive-framed inverse of the F8 risk
   * band. PROJECTED SERVER-SIDE in the members page row-mapping via the
   * canonical `projectEngagementScore`; null when unscored. The cell only
   * renders this value (no projection logic). 056-members-table-compact: this
   * is now the sole at-risk surface in the table — the redundant Risk column
   * (raw inverse of the same signal) was dropped.
   */
  readonly engagement: { readonly score: number; readonly band: EngagementBand } | null;
  readonly last_activity_at: string | null;
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
  /**
   * Callback for inline-edit save. 056-members-table-compact: only Status is
   * inline-editable in the table now (country/notes moved to the detail page),
   * so the field is narrowed to `'status'`. The wrapper's wider handler
   * signature (`'status' | 'country' | 'notes'`) is still assignable here.
   */
  readonly onInlineEdit?: ((
    memberId: string,
    field: 'status',
    value: string | null,
  ) => Promise<InlineEditResult>) | undefined;
};

const columnHelper = createColumnHelper<MembersTableRow>();

/**
 * Per-column server-default sort order — single source of truth for the arrow
 * icon, the `<th>` aria-sort, AND the server default. Must match
 * drizzle-member-repo.ts:
 *   memberNumber: ASC NULLS LAST (the else-branch when order !== 'desc')
 *   engagement:   DESC (healthiest first; engagement DESC = risk ASC)
 * When `?sort=<col>` is present but `&order=` is absent (bookmarked /
 * hand-edited / deep-link URL), the server uses these defaults.
 */
const COLUMN_DEFAULT_ORDER: Record<string, 'asc' | 'desc'> = {
  memberNumber: 'asc',
  engagement: 'desc',
};

/**
 * Resolve the effective sort order for a sort key: the explicit `?order=` when
 * valid, else the column's server default. Shared by the two sort-header
 * components (arrow icon) and `ariaSortFor` (the `<th>` aria-sort) so the icon,
 * the announced sort state, and the server's actual ordering can never drift.
 */
function effectiveOrder(
  sortKey: string,
  urlOrder: string | null,
): 'asc' | 'desc' {
  if (urlOrder === 'asc' || urlOrder === 'desc') return urlOrder;
  return COLUMN_DEFAULT_ORDER[sortKey] ?? 'asc';
}

/** Server-side sort control for the member-number column (toggles
 *  `?sort=memberNumber&order=asc|desc`, resetting to page 1). */
function MemberNumberSortHeader() {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get('sort') === 'memberNumber';
  const order = searchParams.get('order');
  const nextOrder = active && order === 'asc' ? 'desc' : 'asc';

  function onSort() {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', 'memberNumber');
    params.set('order', nextOrder);
    params.set('page', '1');
    router.push(`${pathname}?${params.toString()}`);
  }

  // When active but `?order=` is absent, the server defaults to the column
  // default (memberNumber → ASC). The shared `effectiveOrder` helper resolves
  // it so the UP/DOWN arrow stays consistent with the data order and aria-sort.
  const Icon = !active
    ? ArrowUpDownIcon
    : effectiveOrder('memberNumber', order) === 'asc'
      ? ArrowUpIcon
      : ArrowDownIcon;
  // `aria-sort` is NOT placed here: ARIA only allows `aria-sort` on a
  // `role=columnheader` element (the `<th>`/TableHead). The header cell
  // owns it (see MembersTable header render) — putting it on this button
  // is a WCAG 1.3.1 / 4.1.2 violation (axe `aria-allowed-attr`).
  return (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('sortByMemberNumber')}
    >
      {t('columns.memberNumber')}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * F9 (FR-007a) — server-side sort control for the engagement column. Toggles
 * the `?sort=engagement&order=desc|asc` URL params (resetting to page 1); the
 * server re-orders by the inverted F8 risk score. Own client hooks so the
 * columns `useMemo` stays keyed only on `enableSelection`.
 */
function EngagementSortHeader() {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const active = searchParams.get('sort') === 'engagement';
  const order = searchParams.get('order');
  const nextOrder = active && order === 'desc' ? 'asc' : 'desc';

  function onSort() {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', 'engagement');
    params.set('order', nextOrder);
    params.set('page', '1');
    router.push(`${pathname}?${params.toString()}`);
  }

  // When active but `?order=` is absent, the server defaults to the column
  // default (engagement → DESC = healthiest first). The shared `effectiveOrder`
  // helper resolves it so the UP/DOWN arrow stays consistent.
  const Icon = !active
    ? ArrowUpDownIcon
    : effectiveOrder('engagement', order) === 'asc'
      ? ArrowUpIcon
      : ArrowDownIcon;
  // `aria-sort` lives on the `<th>` (columnheader), not this button — see
  // MemberNumberSortHeader for the same WCAG 1.3.1 / 4.1.2 rationale.
  return (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('sortByEngagement')}
    >
      {t('columns.engagement')}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * C7 round-10 ui-design-specialist — column-header affordance for an
 * editable cell. Renders the label + a small pencil icon; hovering /
 * focusing the icon surfaces the inline-edit instruction. Only mounted
 * when the caller passes `editable={true}` — manager view drops it.
 *
 * 056-members-table-compact — the only remaining inline-editable column is
 * Status (the country/notes inline cells were removed; those fields are now
 * edited on the member detail page).
 *
 * Icon-only (no "Editable" text) per maintainer feedback — keeps the
 * column header compact. `aria-label` + Tooltip carry the meaning for
 * sighted + SR users.
 */
function EditableColumnHeader({
  label,
  editable,
}: {
  label: string;
  editable: boolean;
}) {
  const t = useTranslations('admin.members.inlineEdit');
  if (!editable) return <>{label}</>;
  // Round-11 review fix — TooltipProvider HOISTED to MembersTable root.
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      {/* WCAG 2.2 SC 2.5.8: tap target ≥ 24×24 px — raised from size-4 (16px) to min size-6 (24px). */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t('columnHeaderHintTooltip')}
            />
          }
        >
          <PencilLineIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipContent>{t('columnHeaderHintTooltip')}</TooltipContent>
      </Tooltip>
    </span>
  );
}

function StatusBadge({ status }: { status: MembersTableRow['status'] }) {
  const t = useTranslations('admin.members.directory');
  const label = t(`filters.status.${status}`);
  // P10 round-10 ui-design-specialist — archived was visually identical
  // to a generic neutral chip (outline variant only, no icon). Surface
  // an ArchiveIcon prefix + secondary variant so the archive state is
  // scan-able at a glance in a 50-row directory.
  if (status === 'archived') {
    return (
      <Badge variant="secondary" className="gap-1">
        <ArchiveIcon aria-hidden="true" className="size-3" />
        <span>{label}</span>
      </Badge>
    );
  }
  const variant: 'default' | 'secondary' =
    status === 'active' ? 'default' : 'secondary';
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
  // P8 round-10 — pair "saving" announcement with a "saved" flash so
  // SR users hear closure on the inline-edit transaction, not just the
  // start. Auto-clears after 2s so the live region stays quiet.
  const [savedFlash, setSavedFlash] = useState(false);
  const [optimistic, setOptimistic] = useState(status);

  // Round-2 review I-4: sync optimistic state when the `status` prop
  // changes (e.g. after router.refresh() following a bulk action while
  // the cell is still mounted). Without this, optimistic stays stale.
  useEffect(() => {
    setOptimistic(status);
  }, [status]);

  useEffect(() => {
    if (!savedFlash) return;
    const id = setTimeout(() => setSavedFlash(false), 2000);
    return () => clearTimeout(id);
  }, [savedFlash]);

  const handleToggle = useCallback(async () => {
    if (!onSave || status === 'archived') return;
    const next = optimistic === 'active' ? 'inactive' : 'active';
    setOptimistic(next);
    setSaving(true);
    const result = await onSave(memberId, 'status', next);
    setSaving(false);
    if (result.ok) {
      setSavedFlash(true);
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
        {saving ? t('saving') : savedFlash ? t('saved') : ''}
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
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const lastSelectedRef = useRef<number | null>(null);
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // WCAG 1.3.1 / 4.1.2 — `aria-sort` belongs on the `role=columnheader`
  // (the `<th>`/TableHead), not on the inner sort button. Derive the
  // sorted column + direction once from the URL and stamp it on the
  // matching header cell below. The two sortable columns (`member_number`,
  // `engagement`) map 1:1 to the `?sort=` value via this table.
  const activeSort = searchParams.get('sort');
  const activeOrder = searchParams.get('order');

  const ariaSortFor = (
    columnId: string,
  ): 'ascending' | 'descending' | undefined => {
    const sortKeyByColumnId: Record<string, string> = {
      member_number: 'memberNumber',
      engagement: 'engagement',
    };
    const sortKey = sortKeyByColumnId[columnId];
    if (!sortKey || activeSort !== sortKey) return undefined;
    // Shared helper: explicit `?order=` when valid, else the server's per-column
    // default — so the `<th>` aria-sort matches the header arrow + the server.
    return effectiveOrder(sortKey, activeOrder) === 'asc'
      ? 'ascending'
      : 'descending';
  };

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
                // Base UI exposes indeterminate as its own prop (sets
                // aria-checked="mixed") — show it when SOME but not ALL page
                // rows are selected so the header reflects a partial selection.
                indeterminate={
                  table.getIsSomePageRowsSelected() &&
                  !table.getIsAllPageRowsSelected()
                }
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
    columnHelper.display({
      id: 'member_number',
      header: () => <MemberNumberSortHeader />,
      cell: (info) => (
        <span className="whitespace-nowrap tabular-nums text-sm">
          {info.row.original.member_number_display}
        </span>
      ),
      size: 90,
    }),
    // 056-members-table-compact — Company cell leads with the country flag
    // (the standalone Country column was removed; country is edited on the
    // detail page). Null country → no flag, just the name. The flag carries
    // the localised country name via its hover `title` + SR `aria-label`
    // (CountryDisplay variant="flag-only"), so a11y is intact.
    columnHelper.accessor('company_name', {
      header: () => t('columns.company'),
      cell: (info) => {
        const country = info.row.original.country;
        return (
          <span className="inline-flex items-center gap-2">
            {country && (
              <CountryDisplay code={country} variant="flag-only" />
            )}
            <span className="font-medium">{info.getValue()}</span>
          </span>
        );
      },
    }),
    // 056-members-table-compact — merged "Plan · Year" cell (the standalone
    // Year column was removed). Middot separator is a locale-neutral literal.
    columnHelper.accessor('plan_display_name', {
      header: () => t('columns.plan'),
      cell: (info) => {
        const displayName = info.getValue();
        const row = info.row.original;
        const label = displayName ?? row.plan_id;
        return (
          <span title={row.plan_id} className="text-sm whitespace-nowrap">
            {label} · {row.plan_year}
          </span>
        );
      },
    }),
    // 056-members-table-compact — Contact shows the name only (the email
    // second line was dropped to keep the column compact).
    columnHelper.accessor('primary_contact', {
      header: () => t('columns.primaryContact'),
      cell: (info) => {
        const c = info.getValue();
        if (!c) return <span className="text-muted-foreground">{t('noPrimary')}</span>;
        return <span>{`${c.first_name} ${c.last_name}`.trim()}</span>;
      },
    }),
    columnHelper.accessor('status', {
      header: () => (
        <EditableColumnHeader
          label={t('columns.status')}
          editable={enableSelection}
        />
      ),
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
    // 056-members-table-compact — the standalone Risk column was removed.
    // Engagement (below) is the positive-framed inverse of the same F8 risk
    // signal, so the raw Risk column was redundant.
    // F9 (T034) — Engagement Score column: positive-framed inverse of the F8
    // risk score, projected on read. Non-colour encoding (numeric score + text
    // band label, FR-035). Server-side sortable via `?sort=engagement&order=`
    // (FR-007a); nulls render "—" (and sort last server-side).
    columnHelper.accessor('engagement', {
      header: () => <EngagementSortHeader />,
      cell: (info) => {
        // G1: engagement is PROJECTED SERVER-SIDE in the page row-mapping via
        // the canonical `projectEngagementScore` (@/modules/insights) — this
        // client cell just renders the result (numeric score + non-colour text
        // band, FR-035). null = unscored → "—" (sorts last server-side).
        const eng = info.getValue();
        if (eng === null) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="inline-flex items-center gap-1.5">
            <span className="tabular-nums font-medium">{eng.score}</span>
            <span className="text-caption text-muted-foreground">
              {t(`engagementBand.${eng.band}`)}
            </span>
          </span>
        );
      },
    }),
    columnHelper.accessor('last_activity_at', {
      header: () => t('columns.lastActivity'),
      cell: (info) => {
        const v = info.getValue();
        if (!v) return <span className="text-muted-foreground">—</span>;
        // Root-cause hydration fix: `<RelativeTime>` renders a stable
        // absolute date during SSR + first paint, then flips to the
        // "X seconds ago" relative-time string after `useEffect` runs
        // (client-only). Replaces the previous `suppressHydrationWarning`
        // pattern which only silenced the warning while still rendering
        // wrong text on first paint.
        return (
          <RelativeTime
            iso={v}
            title={v.replace('T', ' ').slice(0, 16)}
            locale={locale}
          />
        );
      },
    }),
    // 056-members-table-compact — the Notes column was removed; notes are
    // edited on the member detail page.
  ], [enableSelection, onInlineEdit, t, locale, rows, rowSelection, handleRowSelectionChange]);

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
    /* Round-11 review fix — single TooltipProvider hoisted here so
       `EditableColumnHeader` (×3 in admin view) + risk-cell tooltip
       (×N rows with null band) don't each instantiate their own
       provider per render. Tooltip race + Tab order noise resolved. */
    <TooltipProvider>
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
      {/* WCAG 1.3.1 — visually-hidden caption identifies the table for
          screen reader users who navigate table landmarks. */}
      <Table aria-label={t('tableCaption')}>
        <caption className="sr-only">{t('tableCaption')}</caption>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const ariaSort = ariaSortFor(header.column.id);
                return (
                <TableHead
                  key={header.id}
                  scope="col"
                  className="text-xs uppercase tracking-wide text-muted-foreground"
                  {...(ariaSort ? { 'aria-sort': ariaSort } : {})}
                >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                );
              })}
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
                  className={`hover:bg-accent/40 focus-within:bg-accent/40 ${
                    row.getIsSelected() ? 'bg-accent/20' : ''
                  }`}
                >
                  {row.getVisibleCells().map((cell, idx) => (
                    <TableCell key={cell.id} className="align-middle">
                      {/* Company name column is the row link.
                          No selection: member_number=0, company=1
                          With selection: select=0, member_number=1, company=2 */}
                      {!enableSelection && idx === 1 ? (
                        <Link
                          href={`/admin/members/${m.member_id}`}
                          aria-label={t('rowAriaLabel', { company: m.company_name })}
                          className="cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </Link>
                      ) : enableSelection && idx === 2 ? (
                        <Link
                          href={`/admin/members/${m.member_id}`}
                          aria-label={t('rowAriaLabel', { company: m.company_name })}
                          className="cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
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
    </TooltipProvider>
  );
}

/** Export for BulkActionBar to read the current selection count. */
export { type RowSelectionState };
