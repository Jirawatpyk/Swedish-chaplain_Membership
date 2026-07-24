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
import { Checkbox } from '@/components/ui/checkbox';
import {
  ArchiveIcon,
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CheckIcon,
  MailWarning,
  PauseCircle,
  PencilIcon,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the insights server graph). The engagement value is projected server-side.
import type { EngagementBand } from '@/modules/insights';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the members server graph). The portal state is derived server-side.
import type { PortalState } from '@/modules/members';
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
   * #4 — true when the member's most-recent renewal cycle has lapsed
   * (terminal lapsed/cancelled, past expiry). Derived server-side in the page
   * via loadMembersMembershipStatus; the cell renders a badge when true.
   * Always set (never optional) to match the row-builder's exhaustive map.
   */
  readonly membership_lapsed: boolean;
  /**
   * Task 16 (059-membership-suspension) — true when the member's most-recent
   * renewal cycle is temporarily paused (unpaid / pending-admin-review / a
   * non-terminal cycle whose grace period already ended). Derived
   * server-side via the same `loadMembersMembershipStatus` batch read as
   * `membership_lapsed`; mutually exclusive with it by construction
   * (`deriveMembershipAccess` never returns both for one cycle). Always set
   * (never optional) to match the row-builder's exhaustive map.
   */
  readonly membership_suspended: boolean;
  /**
   * Portal state of the PRIMARY contact (design doc 2026-07-23 §3.5).
   * `null`  = the member has no primary contact (nothing to render).
   * 'unknown' = the batch read failed; renders nothing, but is deliberately
   * distinct from 'not_invited' so a DB hiccup is never displayed as
   * "this member still needs inviting".
   */
  readonly portal_state: PortalState | 'unknown' | null;
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
    // Optional so existing fixtures that omit it still type-check; page.tsx
    // supplies it from Contact.inviteBouncedAt for the directory bounce badge.
    readonly invite_bounced?: boolean;
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
  /**
   * Total rows matching the current filters across ALL pages. When provided,
   * the sr-only result-count live region announces "Showing N of M members"
   * (this page's count vs the full filtered total) so screen-reader users hear
   * how a filter change narrowed the set, not just the current page size.
   */
  readonly total?: number | undefined;
  // #2 select-all-matching. When the whole visible page is selected and more
  // matching rows exist across pages, the table offers "Select all N matching";
  // clicking it calls `onSelectAllMatching` and the PARENT fetches the matching
  // ids (/api/members/ids, capped at BULK_CAP) + drives the effective bulk
  // selection. The table only renders the banner + reports the intent.
  /** Offer handler — fetch + apply the cross-page matching selection. */
  readonly onSelectAllMatching?: (() => void) | undefined;
  /** True once the parent holds an active cross-page matching selection. */
  readonly matchingActive?: boolean | undefined;
  /** Ids actually selected (≤ BULK_CAP). */
  readonly matchingCount?: number | undefined;
  /** Total matching across pages (may exceed matchingCount when capped). */
  readonly matchingTotal?: number | undefined;
  /** True when the matching set was capped at BULK_CAP. */
  readonly matchingCapped?: boolean | undefined;
  /** Clear the cross-page matching selection. */
  readonly onClearMatching?: (() => void) | undefined;
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

/**
 * BUG-013: archived (soft-deleted) rows are not a valid target for either bulk
 * action, so they are non-selectable. Single source of truth for BOTH the
 * TanStack `enableRowSelection` predicate and the shift-range selection loop
 * (which writes rowSelection directly, bypassing TanStack's gate) so the two
 * paths cannot disagree about what is selectable.
 */
function isMemberRowSelectable(row: MembersTableRow): boolean {
  return row.status !== 'archived';
}

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
    const previous = optimistic;
    const next = previous === 'active' ? 'inactive' : 'active';
    setOptimistic(next);
    setSaving(true);
    const result = await onSave(memberId, 'status', next);
    setSaving(false);
    if (result.ok) {
      setSavedFlash(true);
      // 10-second Undo (ux-patterns §2.3) — re-run the same inline-edit handler
      // with the PREVIOUS value. Pure client re-call; no new backend surface.
      toast.success(t('statusUpdated'), {
        duration: 10_000,
        action: {
          label: t('undo'),
          onClick: async () => {
            setOptimistic(previous);
            const undoResult = await onSave(memberId, 'status', previous);
            if (undoResult.ok) {
              toast.success(t('statusUpdated'));
            } else {
              setOptimistic(next); // undo failed — keep the applied value
              toast.error(undoResult.error);
            }
          },
        },
      });
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

/**
 * Portal-state badge for the Contact cell (design doc 2026-07-23 §3.5).
 *
 * Short visible label + sr-only sentence — `Badge` is overflow-hidden,
 * nowrap and shrink-0, so a long label cannot wrap and would paint over the
 * next column. Every state pairs an icon and text with its colour, so nothing
 * is encoded by colour alone (WCAG 1.4.1).
 *
 * `active` uses `secondary`, not `default`: the solid primary token would make
 * the most common and least actionable state the loudest thing on a 50-row
 * page, and it is the same token as the detail page's "Primary" contact badge.
 */
function PortalBadge({ state }: { state: MembersTableRow['portal_state'] }) {
  const t = useTranslations('admin.members.directory');
  if (state === null || state === 'unknown') return null;
  if (state === 'active') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckIcon aria-hidden="true" className="size-3" />
        <span aria-hidden="true">{t('portal.linked')}</span>
        <span className="sr-only">{t('portal.linkedSr')}</span>
      </Badge>
    );
  }
  if (state === 'not_invited') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        <span aria-hidden="true">{t('portal.notInvited')}</span>
        <span className="sr-only">{t('portal.notInvitedSr')}</span>
      </Badge>
    );
  }
  const expired = state === 'invite_expired';
  return (
    <Badge
      variant="outline"
      className={
        expired
          ? 'gap-1 border-destructive/40 text-destructive'
          : 'gap-1 border-warning/40 text-warning'
      }
    >
      <MailWarning aria-hidden="true" className="size-3" />
      <span aria-hidden="true">{t(expired ? 'portal.expired' : 'portal.invited')}</span>
      <span className="sr-only">{t(expired ? 'portal.expiredSr' : 'portal.invitedSr')}</span>
    </Badge>
  );
}

export function MembersTable({
  rows,
  total,
  enableSelection = false,
  onSelectionChange,
  onInlineEdit,
  onSelectAllMatching,
  matchingActive = false,
  matchingCount,
  matchingTotal,
  matchingCapped = false,
  onClearMatching,
}: Props) {
  const t = useTranslations('admin.members.directory');
  const tContact = useTranslations('admin.members.detail');
  const locale = useLocale();
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
                // BUG-013: disabled for archived rows (enableRowSelection
                // returns false → getCanSelect() is false).
                disabled={!row.getCanSelect()}
                onCheckedChange={(checked) => row.toggleSelected(!!checked)}
                onClick={(e: React.MouseEvent) => {
                  // Shift+Click range selection (FR-040)
                  if (e.shiftKey && lastSelectedRef.current !== null) {
                    const start = Math.min(lastSelectedRef.current, row.index);
                    const end = Math.max(lastSelectedRef.current, row.index);
                    const next = { ...rowSelection };
                    for (let i = start; i <= end; i++) {
                      // getRowId uses member_id, so key by member_id. Skip
                      // archived rows to match enableRowSelection (BUG-013):
                      // shift-range writes rowSelection directly, so without
                      // this guard it could select a non-selectable row.
                      const rangeRow = rows[i];
                      if (rangeRow && isMemberRowSelectable(rangeRow)) {
                        next[rangeRow.member_id] = true;
                      }
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
      size: 220,
      header: () => t('columns.company'),
      cell: (info) => {
        const country = info.row.original.country;
        const name = info.getValue();
        return (
          // `flex` (not inline-flex) so the name WRAPS instead of forcing the
          // cell — and the table — wider than the viewport. The name shows in
          // FULL (wraps to as many lines as needed, no ellipsis); `max-w`
          // bounds the column width so a long legal name grows DOWN, not across.
          <span className="flex items-start gap-2">
            {country && (
              <span className="shrink-0 pt-0.5">
                <CountryDisplay code={country} variant="flag-only" />
              </span>
            )}
            <span
              className="max-w-[26ch] font-medium break-words whitespace-normal"
              title={name}
            >
              {name}
            </span>
          </span>
        );
      },
    }),
    // 056-members-table-compact — merged "Plan · Year" cell (the standalone
    // Year column was removed). Middot separator is a locale-neutral literal.
    // Widened 150→185 (user request, 2026-07-23): after the 057 overflow fix
    // long plan names wrap instead of overflowing, so a wider column keeps the
    // common "<plan name> · <year>" on one line and reduces two-line rows.
    columnHelper.accessor('plan_display_name', {
      size: 185,
      header: () => t('columns.plan'),
      cell: (info) => {
        const displayName = info.getValue();
        const row = info.row.original;
        const label = displayName ?? row.plan_id;
        return (
          // 057 overflow fix — `whitespace-normal break-words` replaces
          // `whitespace-nowrap`. Under `table-fixed` + <colgroup>, nowrap
          // content wider than the 150px column PAINTS OVER the next column
          // (td is overflow:visible). Wrapping keeps a long plan name inside
          // its column; short names still render on one line, so row density
          // is unchanged for the common case. `break-words` covers a single
          // long token with no spaces.
          <span
            title={row.plan_id}
            className="text-sm whitespace-normal break-words"
          >
            {label}
            <span aria-hidden="true"> · </span>
            {row.plan_year}
          </span>
        );
      },
    }),
    // 056-members-table-compact — Contact shows the name only (the email
    // second line was dropped to keep the column compact).
    columnHelper.accessor('primary_contact', {
      // Widened 175→205 (user request, 2026-07-23): the cell holds the contact
      // name plus the portal/bounce badges inline, so the extra width keeps the
      // common "name + one badge" case on a single line before it wraps.
      size: 205,
      header: () => t('columns.primaryContact'),
      cell: (info) => {
        const c = info.getValue();
        if (!c) return <span className="text-muted-foreground">{t('noPrimary')}</span>;
        const fullName = `${c.first_name} ${c.last_name}`.trim();
        return (
          // 057 badge-inline (user request 2026-07-23): the portal + bounce
          // badges flow INLINE after the contact name on the SAME line, and
          // wrap to a new line only when the column is too narrow. Name and
          // badges are siblings of ONE `flex flex-wrap` container (not a
          // stacked name-row + badge-row), so the common "name + one short
          // badge" case stays a single line and keeps the row compact.
          // `flex-wrap` is required because Badge is `shrink-0` — without it a
          // long name + badge would overflow the 175px column instead of
          // wrapping. The name span keeps its own `max-w`/`break-words`, so a
          // very long name wraps within itself and pushes the badges down.
          // `items-start` (not `items-center`): when a long name wraps to two
          // lines, `items-center` would vertically centre the one-line badges
          // against the whole two-line name block, reading oddly. `items-start`
          // sits the badges on the name's first line, which is correct for the
          // wrapped case and unchanged for the common single-line case.
          <span className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span
              className="min-w-0 max-w-[18ch] break-words whitespace-normal"
              title={fullName}
            >
              {fullName}
            </span>
            <PortalBadge
              state={
                // Suppress ALL portal badges on archived rows — mirrors the
                // Lapsed/Suspended badge suppression on the Status cell below.
                info.row.original.status === 'archived'
                  ? null
                  : info.row.original.portal_state
              }
            />
            {/* Edge Case "Invitation email bounce" (spec §613-620) — surface a
                row-level bounce signal in the directory, not only on the detail
                page. Copy lives under admin.members.detail.inviteBounced.
                Bounce badge suppressed when the invitation ALSO expired or
                the contact is already active — one root cause, one recovery
                (mirrors admin/members/[memberId]/page.tsx:415-417). Also
                suppressed on archived rows — mirrors the PortalBadge suppression
                above and the Status cell's Lapsed/Suspended suppression: "no
                portal-related badge shows on an archived row" (Task 7). */}
            {c.invite_bounced &&
            info.row.original.portal_state !== 'invite_expired' &&
            info.row.original.portal_state !== 'active' &&
            info.row.original.status !== 'archived' ? (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-destructive/40 text-destructive"
              >
                <TriangleAlert aria-hidden="true" className="size-3" />
                <span aria-hidden="true">{tContact('inviteBounced.badge')}</span>
                <span className="sr-only">
                  {tContact('inviteBounced.badgeAria')}
                </span>
              </Badge>
            ) : null}
          </span>
        );
      },
    }),
    columnHelper.accessor('status', {
      size: 130,
      header: () => t('columns.status'),
      // #4 — the Lapsed badge is a SIBLING of the status control, OUTSIDE the
      // InlineStatusCell <button>. Inside the button it would fire the status
      // toggle on click and pollute the button's accessible name.
      cell: (info) => (
        // 057 overflow fix — the status control plus a Lapsed/Suspended badge
        // exceeds the 130px column when laid out horizontally and paints over
        // the Engagement column. `flex-col` stacks the badge onto its own
        // line instead. See the #4 comment above for why the badge must stay
        // a sibling of InlineStatusCell, not a child.
        <span className="flex flex-col items-start gap-1">
          {enableSelection ? (
            <InlineStatusCell
              memberId={info.row.original.member_id}
              status={info.getValue()}
              onSave={onInlineEdit}
            />
          ) : (
            <StatusBadge status={info.getValue()} />
          )}
          {/* 067 #4 review-fix — suppress the lapsed badge for archived
              members. The badge surfaces "active-looking but lapsed"
              awareness; on an archived row (only visible via ?show_archived=1)
              it is redundant next to the Archived status badge — archived
              already means out. Task 16: Lapsed (red/terminated) takes
              priority over Suspended (amber) when both are somehow true —
              they're mutually exclusive by construction
              (deriveMembershipAccess), but the render still needs a
              deterministic single choice. */}
          {info.row.original.membership_lapsed && info.getValue() !== 'archived' ? (
            <Badge
              variant="outline"
              className="gap-1 border-destructive/40 text-destructive"
            >
              <TriangleAlert aria-hidden="true" className="size-3" />
              {/* visible label is aria-hidden so a SR user hears ONLY the full
                  sr-only phrase below, not "Lapsed Membership lapsed …" twice. */}
              <span aria-hidden="true">{t('membershipLapsed')}</span>
              <span className="sr-only">{t('membershipLapsedSr')}</span>
            </Badge>
          ) : info.row.original.membership_suspended && info.getValue() !== 'archived' ? (
            <Badge
              variant="outline"
              className="gap-1 border-warning/40 text-warning"
            >
              <PauseCircle aria-hidden="true" className="size-3" />
              {/* Non-colour-alone encoding: distinct icon (PauseCircle vs
                  TriangleAlert) + distinct visible label + distinct sr-only
                  phrase from the Lapsed badge above, on top of the amber vs
                  red colour token. */}
              <span aria-hidden="true">{t('membershipSuspended')}</span>
              <span className="sr-only">{t('membershipSuspendedSr')}</span>
            </Badge>
          ) : null}
        </span>
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
      size: 130,
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
      size: 150,
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
  ], [enableSelection, onInlineEdit, t, tContact, locale, rows, rowSelection, handleRowSelectionChange]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table v8 hook
  const table = useReactTable({
    data: rows as MembersTableRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    // BUG-013: archived (soft-deleted) rows are not a valid target for either
    // bulk action (archive rejects already-archived; send-portal-invite makes
    // no sense for a removed member), so make them non-selectable. TanStack
    // then disables their checkbox, excludes them from select-all, and blocks
    // programmatic selection. Managers keep no selection at all.
    enableRowSelection: enableSelection
      ? (row) => isMemberRowSelectable(row.original)
      : false,
    onRowSelectionChange: handleRowSelectionChange,
    state: {
      rowSelection,
    },
    getRowId: (row) => row.member_id,
  });

  const selectedCount = Object.keys(rowSelection).filter(
    (k) => rowSelection[k],
  ).length;

  // BUG-013 follow-up: derive "whole page selected" from the table's own
  // all-selected state, which respects enableRowSelection (archived rows are
  // non-selectable). `selectedCount === rows.length` would never hold once an
  // archived row is on the page, hiding the "Select all N matching" banner and
  // contradicting the header select-all checkbox (which also uses this).
  const allPageSelected =
    enableSelection && rows.length > 0 && table.getIsAllPageRowsSelected();
  // #2 — numbered/offset pagination has no cursor; "more matching exist beyond
  // this page" is simply the full filtered total exceeding the rows shown here.
  const hasMoreMatching =
    enableSelection && total !== undefined && total > rows.length;

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
      {/* Result-count live region — announces the row count on ANY filter
          change (not only the selection count above), so screen-reader users
          hear the table update after e.g. toggling the needs-invite chip. When
          the full filtered total is known it announces "N of M" for context. */}
      <div className="sr-only" role="status">
        {total !== undefined
          ? t('resultsCountOfTotal', { count: rows.length, total })
          : t('resultsCount', { count: rows.length })}
      </div>
      {enableSelection && selectedCount > 0 && (
        <div
          className="sr-only"
          aria-live="polite"
          aria-atomic="true"
        >
          {t('selectedCount', { count: selectedCount })}
        </div>
      )}
      {/* #2 cross-page "Select all N matching". Two states:
          (a) OFFER — whole visible page selected + more matching rows exist
              beyond it: clicking asks the parent to fetch the matching ids
              (capped at BULK_CAP) so a bulk action reaches the whole filtered
              set, not just this page.
          (b) ACTIVE — the parent holds the cross-page selection: show the count
              (capped copy when the set was clamped to BULK_CAP) + a Clear. */}
      {matchingActive ? (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-accent bg-accent/40 px-4 py-2 text-sm"
          role="status"
        >
          <span>
            {matchingCapped
              ? t('matchingSelectedCapped', {
                  count: matchingCount ?? 0,
                  total: matchingTotal ?? matchingCount ?? 0,
                })
              : t('matchingSelected', { count: matchingCount ?? 0 })}
          </span>
          {onClearMatching && (
            <button
              type="button"
              className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={onClearMatching}
            >
              {t('clearMatching')}
            </button>
          )}
        </div>
      ) : (
        allPageSelected &&
        hasMoreMatching &&
        onSelectAllMatching && (
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-accent bg-accent/40 px-4 py-2 text-sm"
            role="status"
          >
            <span>{t('allPageSelected', { count: selectedCount })}</span>
            <button
              type="button"
              className="font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={onSelectAllMatching}
            >
              {t('selectAllMatching', { count: total ?? 0 })}
            </button>
          </div>
        )
      )}
      {/* WCAG 1.3.1 — visually-hidden caption identifies the table for
          screen reader users who navigate table landmarks. */}
      {/* `table-fixed` + an explicit <colgroup> pin the column widths to the
          header, NOT the cell content. Without this the default
          `table-layout: auto` recomputes every column's width from the current
          rows, so the header visibly SHIFTS each time a search changes the data.
          Widths come from the column defs' `size` (px).
          `minWidth: getTotalSize()` is REQUIRED: under `table-fixed`, if the
          column widths sum to more than the table's rendered width, the browser
          SHRINKS every column to fit rather than overflowing — squeezing the
          `whitespace-nowrap` cells (which have no ellipsis) into overlap. Pinning
          the table's min-width to the column total keeps each column at its
          intended size and lets the `overflow-x-auto` wrapper (ui/table.tsx)
          engage on viewports narrower than the total, so the header stays
          aligned AND narrow viewports scroll instead of clipping. */}
      <Table
        aria-label={t('tableCaption')}
        className="table-fixed"
        style={{ minWidth: table.getTotalSize() }}
      >
        <caption className="sr-only">{t('tableCaption')}</caption>
        <colgroup>
          {table.getVisibleLeafColumns().map((col) => (
            <col key={col.id} style={{ width: `${col.getSize()}px` }} />
          ))}
        </colgroup>
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
                          className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
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
                          className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
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
  );
}

/** Export for BulkActionBar to read the current selection count. */
export { type RowSelectionState };
