'use client';

/**
 * T065 + T108 + T112 — Members directory table.
 *
 * 122 US5a (T502) — AURA `DataTable` in server mode (`manual`, no built-in
 * pager: the parent renders the numbered `TablePagination`). The rows are
 * already the server's current page, sorted by the server; a header click
 * writes the same `?sort=&order=&page=1` URL the old header buttons wrote.
 *
 * Columns (board `Admin-members`): Company (flag + name, the row link and the
 * phone card title) │ Member No. │ Primary contact │ Plan · Year │ Status │
 * Engagement │ Last activity │ "⋯" row menu. Contact, plan and last activity
 * hide below `lg`; below 640 px the rows become cards (`stackBelow`). Company
 * leads (the board draws Member No. first) because AURA uses the first column
 * as both the row link and the card title.
 *
 * T108 (US4): admin-only selection — archived rows are not selectable,
 * Shift+Click selects a range, Ctrl/Cmd+A selects the page, and "Select all
 * N matching" hands the cross-page selection to the parent (FR-040).
 *
 * T112 (US4): the Status cell is an inline toggle with aria-live save
 * announcements and a 10-second Undo.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import {
  AuraProvider,
  Badge,
  DataTable,
  DropdownMenu,
  IconButton,
  StatusPill,
  type DataTableColumn,
  type DataTableSort,
  type MenuItem,
} from '@jirawatpyk/aura-react';
import {
  ArchiveIcon,
  MailWarning,
  PencilIcon,
  PauseCircle,
  TriangleAlert,
} from 'lucide-react';
import { RelativeTime } from '@/components/shell/relative-time';
import { toast } from '@/lib/toast';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the insights server graph). The engagement value is projected server-side.
import type { EngagementBand } from '@/modules/insights';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the members server graph). The portal state is derived server-side.
import type { PortalState } from '@/modules/members';
// C4 round-10 ui-design-specialist — flag emoji + localised country name.
// 056-members-table-compact — the flag now leads the Company cell.
import { CountryDisplay } from './country-display';
import { MEMBERS_COLUMN_SIZES } from './members-table-columns';

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
  /**
   * A search or filter is applied. The count above the table shows only then
   * (board `Admin-members-tablet`); unfiltered, the pagination range below
   * says the same, so the count stays for screen readers only.
   */
  readonly filtered?: boolean | undefined;
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
  /**
   * Bumped by the parent's Clear to command a full reset of this table's own
   * row selection — the parent can't reach the checkbox state otherwise, so
   * without this Clear leaves the page rows checked.
   */
  readonly clearSelectionNonce?: number | undefined;
  /** Admin-only: enable multi-row selection + inline edit. */
  readonly enableSelection?: boolean | undefined;
  /**
   * 122 US5a — the row menu offers "Edit member" (members.write). "Open
   * member" is always there.
   */
  readonly canEdit?: boolean | undefined;
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
 * table's `isRowSelectable` predicate and the Shift-range and Ctrl/Cmd+A
 * selections (which write the selection directly) so the paths cannot
 * disagree about what is selectable.
 */
function isMemberRowSelectable(row: MembersTableRow): boolean {
  return row.status !== 'archived';
}

type SortKey = 'memberNumber' | 'engagement';

/** Table column key ↔ the `?sort=` value, for the two sortable columns. */
const SORT_KEY_BY_COLUMN: Readonly<Record<string, SortKey>> = {
  member_number_display: 'memberNumber',
  engagement: 'engagement',
};
const COLUMN_BY_SORT_KEY: Readonly<Record<SortKey, string>> = {
  memberNumber: 'member_number_display',
  engagement: 'engagement',
};

/**
 * Per-column server-default sort order — single source of truth for the
 * announced sort state AND the server default. Must match
 * drizzle-member-repo.ts:
 *   memberNumber: ASC NULLS LAST (the else-branch when order !== 'desc')
 *   engagement:   DESC (healthiest first; engagement DESC = risk ASC)
 * When `?sort=<col>` is present but `&order=` is absent (bookmarked /
 * hand-edited / deep-link URL), the server uses these defaults.
 */
const COLUMN_DEFAULT_ORDER: Readonly<Record<SortKey, 'asc' | 'desc'>> = {
  memberNumber: 'asc',
  engagement: 'desc',
};

/**
 * Resolve the effective sort order for a sort key: the explicit `?order=` when
 * valid, else the column's server default — so the header's aria-sort and the
 * server's actual ordering can never drift.
 */
function effectiveOrder(sortKey: SortKey, urlOrder: string | null): 'asc' | 'desc' {
  if (urlOrder === 'asc' || urlOrder === 'desc') return urlOrder;
  return COLUMN_DEFAULT_ORDER[sortKey];
}

/**
 * The order a header click asks for — the same rule the old header buttons
 * used: Member No. goes asc unless it is already asc; Engagement goes desc
 * unless it is already desc.
 */
function nextOrderFor(sortKey: SortKey, active: boolean, urlOrder: string | null): 'asc' | 'desc' {
  if (sortKey === 'memberNumber') return active && urlOrder === 'asc' ? 'desc' : 'asc';
  return active && urlOrder === 'desc' ? 'asc' : 'desc';
}

function StatusBadge({ status }: { status: MembersTableRow['status'] }) {
  const t = useTranslations('admin.members.directory');
  const label = t(`filters.status.${status}`);
  // Board tones: Active = ready; Inactive and Archived are neutral. Archived
  // takes the archive box in place of the pill's circle, so the state scans
  // at a glance in a 50-row page with one icon.
  if (status === 'archived') {
    return (
      <Badge tone="neutral" icon={<ArchiveIcon aria-hidden="true" />}>
        {label}
      </Badge>
    );
  }
  return <StatusPill tone={status === 'active' ? 'ready' : 'neutral'}>{label}</StatusPill>;
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
  const tDirectory = useTranslations('admin.members.directory');
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

  // Same translated label the StatusBadge shows, not the raw status code.
  const currentLabel = tDirectory(`filters.status.${optimistic}`);

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={saving}
      title={t('toggleStatus', { current: currentLabel })}
      className="group inline-flex min-h-6 min-w-[60px] cursor-pointer items-center gap-1 rounded-[var(--aura-radius-sm)] px-1 py-0.5 transition-colors hover:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)] disabled:cursor-wait disabled:opacity-60"
      aria-label={t('toggleStatus', { current: currentLabel })}
    >
      <StatusBadge status={optimistic} />
      <PencilIcon
        className="size-3 text-[var(--aura-fg-tertiary)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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
 * Short visible label + sr-only sentence, so a long label never widens the
 * cell. Every state pairs an icon and text with its colour, so nothing is
 * encoded by colour alone (WCAG 1.4.1).
 *
 * 122 US5a: only the states that need action carry a badge. A linked contact
 * needs nothing, so it shows none and the column stays quiet (maintainer
 * decision, 28 Sep 2026; the board shows no badges at all).
 */
function PortalBadge({ state }: { state: MembersTableRow['portal_state'] }) {
  const t = useTranslations('admin.members.directory');
  if (state === null || state === 'unknown' || state === 'active') return null;
  if (state === 'not_invited') {
    return (
      <Badge variant="outline">
        <span aria-hidden="true">{t('portal.notInvited')}</span>
        <span className="sr-only">{t('portal.notInvitedSr')}</span>
      </Badge>
    );
  }
  const expired = state === 'invite_expired';
  return (
    <Badge tone={expired ? 'danger' : 'warning'} icon={<MailWarning aria-hidden="true" />}>
      <span aria-hidden="true">{t(expired ? 'portal.expired' : 'portal.invited')}</span>
      <span className="sr-only">{t(expired ? 'portal.expiredSr' : 'portal.invitedSr')}</span>
    </Badge>
  );
}

/** Engagement band → badge tone (the board's risk column: healthy is good). */
const ENGAGEMENT_TONE: Readonly<Record<EngagementBand, 'success' | 'neutral' | 'warning' | 'danger'>> = {
  healthy: 'success',
  moderate: 'neutral',
  warning: 'warning',
  critical: 'danger',
};

/**
 * The grid's rows grow to fit (AURA 5.11 `rowHeight="auto"`), so text wraps in
 * full rather than truncating: a long company name or a name beside its badges
 * takes a second line (maintainer's choice, 28 Sep).
 */
const WRAP_TEXT = 'min-w-0 whitespace-normal leading-snug [overflow-wrap:anywhere]';
const WRAP_ROW = 'flex min-w-0 flex-wrap items-center gap-1.5 leading-snug';
/**
 * The status cell is the card's pill, beside the title: on a card its two
 * badges stack so the company name keeps its width.
 */
// Card-mode rules (AURA adds `.aura-table--stacked` below 640px); they reach
// into AURA's table classes, a stand-in until AURA #80 (column card options).
// Bulk work
// and the Edit shortcut stay on wider screens; tapping a card opens the
// member (maintainer's decision, 28 Sep 2026).
const PHONE_CARD = String.raw`[&_.aura-table--stacked_.aura-table\_\_sel]:hidden [&_.aura-table--stacked_.aura-table\_\_head.has-select-all]:hidden [&_.aura-table--stacked_[data-card='actions']]:hidden [&_.aura-table--stacked_.aura-table\_\_td:has([data-card-slot='activity'])]:hidden [&_.aura-table--stacked_.aura-table\_\_td:has([data-card-slot='number'])]:order-5 [&_.aura-table--stacked_.aura-table\_\_td:has([data-card-slot='plan'])]:order-6 [&_.aura-table--stacked_.aura-table\_\_td:has([data-card-slot='contact'])]:order-7 [&_.aura-table--stacked_.aura-table\_\_td:has([data-card-slot='engagement'])]:order-8`;
const STATUS_ROW = `${WRAP_ROW} in-[.aura-table--stacked]:flex-col in-[.aura-table--stacked]:items-end in-[.aura-table--stacked]:gap-1`;

/**
 * 122 US5a — the "⋯" row menu. Only destinations that already exist (spec
 * Clarifications, Session 2026-09-28 US5 start): the member page, and its
 * edit page for members.write.
 */
function RowMenu({ row, canEdit }: { row: MembersTableRow; canEdit: boolean }) {
  const t = useTranslations('admin.members.directory');
  const label = t('rowActions', { company: row.company_name });
  const items: MenuItem[] = [
    { label: t('openMember'), href: `/admin/members/${row.member_id}` },
  ];
  // An archived member is not edited from here, as on its own page (the Edit
  // button there is hidden for archived members).
  if (canEdit && row.status !== 'archived') {
    items.push({
      label: t('editMember'),
      icon: <PencilIcon aria-hidden="true" />,
      href: `/admin/members/${row.member_id}/edit`,
    });
  }
  return (
    <DropdownMenu
      label={label}
      items={items}
      trigger={<IconButton icon="ellipsis" label={label} size="sm" />}
    />
  );
}

export function MembersTable({
  rows,
  total,
  filtered = false,
  enableSelection = false,
  canEdit = false,
  onSelectionChange,
  onInlineEdit,
  onSelectAllMatching,
  matchingActive = false,
  matchingCount,
  matchingTotal,
  matchingCapped = false,
  onClearMatching,
  clearSelectionNonce,
}: Props) {
  const t = useTranslations('admin.members.directory');
  const tContact = useTranslations('admin.members.detail');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<string[]>([]);
  const lastToggledRef = useRef<string | null>(null);
  const shiftClickRef = useRef(false);
  const tableContainerRef = useRef<HTMLDivElement>(null);
  // #2 focus management — the offer/active banner is a DOM-swapping ternary, so
  // clicking a control unmounts it and focus would drop to <body> (this repo's
  // documented focus-loss class). On the offer→active transition move focus to
  // the active banner's Clear; on active→offer (Clear pressed) move it back to
  // the offer button so keyboard/SR users are never stranded.
  const selectAllMatchingBtnRef = useRef<HTMLButtonElement>(null);
  const clearMatchingBtnRef = useRef<HTMLButtonElement>(null);
  const prevMatchingActiveRef = useRef(matchingActive);
  useEffect(() => {
    if (matchingActive && !prevMatchingActiveRef.current) {
      clearMatchingBtnRef.current?.focus();
    } else if (!matchingActive && prevMatchingActiveRef.current) {
      selectAllMatchingBtnRef.current?.focus();
    }
    prevMatchingActiveRef.current = matchingActive;
  }, [matchingActive]);

  // ── Sort: the URL is the source of truth ────────────────────────────────
  const urlSort = searchParams.get('sort');
  const urlOrder = searchParams.get('order');
  const activeSortKey: SortKey | null =
    urlSort === 'memberNumber' || urlSort === 'engagement' ? urlSort : null;
  const sort: DataTableSort | null = activeSortKey
    ? { key: COLUMN_BY_SORT_KEY[activeSortKey], dir: effectiveOrder(activeSortKey, urlOrder) }
    : null;

  const handleSortChange = useCallback(
    (next: DataTableSort | null) => {
      // AURA cycles asc → desc → unsorted; the URL contract never unsorts, so
      // only WHICH header was clicked matters (a null means the active one).
      const column = next?.key ?? (activeSortKey ? COLUMN_BY_SORT_KEY[activeSortKey] : null);
      const sortKey = column ? SORT_KEY_BY_COLUMN[column] : undefined;
      if (!sortKey) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('sort', sortKey);
      params.set('order', nextOrderFor(sortKey, activeSortKey === sortKey, urlOrder));
      params.set('page', '1');
      router.push(`${pathname}?${params.toString()}`);
    },
    [activeSortKey, urlOrder, searchParams, router, pathname],
  );

  // ── Selection (admin only) ──────────────────────────────────────────────
  const selectableIds = useMemo(
    () => rows.filter(isMemberRowSelectable).map((r) => r.member_id),
    [rows],
  );

  const commitSelection = useCallback(
    (next: string[]) => {
      setSelected(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );

  const handleSelectionChange = useCallback(
    (keys: Array<string | number>) => {
      const next = keys.map(String);
      const before = new Set(selected);
      const added = next.filter((k) => !before.has(k));
      const removed = selected.filter((k) => !next.includes(k));
      const toggled = added.length + removed.length === 1 ? (added[0] ?? removed[0]) : undefined;
      const shift = shiftClickRef.current;
      shiftClickRef.current = false;
      // Shift+Click range selection (FR-040): apply the clicked row's new state
      // across the range from the last row clicked without Shift — so a
      // shift-click can DESELECT a range as well as select one. Archived rows in
      // the range stay unselected (BUG-013).
      if (shift && toggled && lastToggledRef.current && lastToggledRef.current !== toggled) {
        const ids = rows.map((r) => r.member_id);
        const a = ids.indexOf(lastToggledRef.current);
        const b = ids.indexOf(toggled);
        if (a !== -1 && b !== -1) {
          const on = added.length === 1;
          const result = new Set(selected);
          for (const row of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            if (!isMemberRowSelectable(row)) continue;
            if (on) result.add(row.member_id);
            else result.delete(row.member_id);
          }
          commitSelection(ids.filter((id) => result.has(id)));
          return;
        }
      }
      if (toggled) lastToggledRef.current = toggled;
      commitSelection(next);
    },
    [selected, rows, commitSelection],
  );

  // Staff-review SW-4: Ctrl+A / Cmd+A within the table selects every
  // selectable row on the current page (FR-040). Scoped to the table container
  // so the shortcut doesn't take over browser-wide text selection elsewhere.
  useEffect(() => {
    if (!enableSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        const active = document.activeElement;
        if (
          tableContainerRef.current &&
          (tableContainerRef.current.contains(active) || active === document.body)
        ) {
          e.preventDefault();
          commitSelection(selectableIds);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enableSelection, commitSelection, selectableIds]);

  // Full selection reset commanded by the parent's Clear (bulk bar or the
  // "select all matching" banner) via `clearSelectionNonce`: the checkboxes
  // clear during render (React's "adjust state when a prop changes" pattern),
  // then the effect tells the parent, so its mirror follows to zero. Guarded
  // on a nonce CHANGE (not mount) so it fires only on an actual Clear.
  const [clearNonceSeen, setClearNonceSeen] = useState(clearSelectionNonce);
  if (clearSelectionNonce !== clearNonceSeen) {
    setClearNonceSeen(clearSelectionNonce);
    setSelected([]);
  }
  const prevClearNonceRef = useRef(clearSelectionNonce);
  useEffect(() => {
    if (clearSelectionNonce !== prevClearNonceRef.current) {
      prevClearNonceRef.current = clearSelectionNonce;
      lastToggledRef.current = null;
      onSelectionChange?.([]);
    }
  }, [clearSelectionNonce, onSelectionChange]);

  const selectedCount = selected.length;
  // BUG-013 follow-up: "whole page selected" means every SELECTABLE row, so a
  // page mixing archived and active rows can still offer the cross-page set.
  const allPageSelected =
    enableSelection &&
    selectableIds.length > 0 &&
    selectableIds.every((id) => selected.includes(id));
  // #2 — numbered/offset pagination has no cursor; "more matching exist beyond
  // this page" is simply the full filtered total exceeding the rows shown here.
  const hasMoreMatching = enableSelection && total !== undefined && total > rows.length;

  // The header checkbox in this page's words ("Select all"); the row
  // checkboxes are named after the company through `rowSelectLabel` (AURA 5.11).
  const tableStrings = useMemo(() => ({ selectAllRows: t('selectAll') }), [t]);

  const columns = useMemo<DataTableColumn<MembersTableRow>[]>(
    () => [
      {
        // 056-members-table-compact — the flag leads the Company cell (country
        // is edited on the detail page). The flexible column; the name wraps
        // in full, no ellipsis (the row grows).
        key: 'company_name',
        label: t('columns.company'),
        ...MEMBERS_COLUMN_SIZES.company_name,
        render: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            {row.country && (
              <span data-card-slot="flag" className="shrink-0 in-[.aura-table--stacked]:hidden">
                <CountryDisplay code={row.country} variant="flag-only" />
              </span>
            )}
            <span className={`font-medium ${WRAP_TEXT}`} title={row.company_name}>
              {row.company_name}
            </span>
          </span>
        ),
      },
      {
        key: 'member_number_display',
        label: t('columns.memberNumber'),
        mono: true,
        ...MEMBERS_COLUMN_SIZES.member_number_display,
        sortable: true,
        render: (row) => <span data-card-slot="number">{row.member_number_display}</span>,
      },
      {
        // Name plus the portal / bounce badge; the badge wraps under a long
        // name.
        key: 'primary_contact',
        label: t('columns.primaryContact'),
        ...MEMBERS_COLUMN_SIZES.primary_contact,
        render: (row) => {
          const c = row.primary_contact;
          if (!c)
            return (
              <span data-card-slot="contact" className="text-[var(--aura-fg-secondary)]">
                {t('noPrimary')}
              </span>
            );
          const fullName = `${c.first_name} ${c.last_name}`.trim();
          const archived = row.status === 'archived';
          // Edge Case "Invitation email bounce" (spec §613-620) — hidden when
          // the invitation also expired or the contact is already active (one
          // root cause, one recovery), and on archived rows.
          const bounced =
            c.invite_bounced &&
            row.portal_state !== 'invite_expired' &&
            row.portal_state !== 'active' &&
            !archived;
          return (
            <span data-card-slot="contact" className={WRAP_ROW}>
              <span className={WRAP_TEXT} title={fullName}>
                {fullName}
              </span>
              {/* No portal-related badge on an archived row (Task 7), and the
                  bounce badge stands in for it: it already says the contact
                  was invited (one root cause, one badge). */}
              <PortalBadge state={archived || bounced ? null : row.portal_state} />
              {bounced ? (
                <Badge tone="danger" icon={<TriangleAlert aria-hidden="true" />}>
                  <span aria-hidden="true">{tContact('inviteBounced.badge')}</span>
                  <span className="sr-only">{tContact('inviteBounced.badgeAria')}</span>
                </Badge>
              ) : null}
            </span>
          );
        },
      },
      {
        // 056-members-table-compact — merged "Plan · Year" cell.
        key: 'plan_display_name',
        label: t('columns.plan'),
        ...MEMBERS_COLUMN_SIZES.plan_display_name,
        render: (row) => (
          <span data-card-slot="plan" title={row.plan_id} className={WRAP_TEXT}>
            {row.plan_display_name ?? row.plan_id}
            {/* " · 2026" never starts a line on its own; a phone card shows
                the plan alone, as on the board. */}
            <span className="whitespace-nowrap in-[.aura-table--stacked]:hidden">
              <span aria-hidden="true"> · </span>
              {row.plan_year}
            </span>
          </span>
        ),
      },
      {
        key: 'status',
        label: t('columns.status'),
        ...MEMBERS_COLUMN_SIZES.status,
        // Sits beside the title on a phone card.
        pill: true,
        // #4 — the Lapsed / Suspended badge is a SIBLING of the status toggle,
        // never inside it (it would fire the toggle and pollute its name). It
        // is hidden on archived rows, and Lapsed wins if both are somehow set.
        render: (row) => (
          <span className={STATUS_ROW}>
            {enableSelection ? (
              <InlineStatusCell memberId={row.member_id} status={row.status} onSave={onInlineEdit} />
            ) : (
              <StatusBadge status={row.status} />
            )}
            {/* Lapsed red, Suspended amber: the suspension design
                (2026-07-13, § Members directory) keeps them apart, so the
                board's tones for these two do not apply. */}
            {row.membership_lapsed && row.status !== 'archived' ? (
              <Badge tone="danger" icon={<TriangleAlert aria-hidden="true" />}>
                {/* visible label is aria-hidden so a SR user hears ONLY the
                    full sr-only phrase, not "Lapsed Membership lapsed …". */}
                <span aria-hidden="true">{t('membershipLapsed')}</span>
                <span className="sr-only">{t('membershipLapsedSr')}</span>
              </Badge>
            ) : row.membership_suspended && row.status !== 'archived' ? (
              <Badge tone="warning" icon={<PauseCircle aria-hidden="true" />}>
                <span aria-hidden="true">{t('membershipSuspended')}</span>
                <span className="sr-only">{t('membershipSuspendedSr')}</span>
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        // F9 (T034) — positive-framed inverse of the F8 risk score, projected
        // server-side; numeric score + text band (FR-035). Unscored → "Not yet
        // scored" in an outline badge (board).
        key: 'engagement',
        label: t('columns.engagement'),
        ...MEMBERS_COLUMN_SIZES.engagement,
        sortable: true,
        render: (row) => {
          const eng = row.engagement;
          if (eng === null)
            return (
              <span data-card-slot="engagement">
                <Badge tone="neutral" variant="outline">
                  {t('riskNotComputed')}
                </Badge>
              </span>
            );
          // A phone card shows the band alone, as on the board.
          return (
            <span data-card-slot="engagement" className="inline-flex items-center gap-1.5">
              <span className="font-medium tabular-nums in-[.aura-table--stacked]:hidden">{eng.score}</span>
              {/* Critical is the one band drawn solid (board). */}
              <Badge tone={ENGAGEMENT_TONE[eng.band]} {...(eng.band === 'critical' ? { variant: 'solid' as const } : {})}>
                {t(`engagementBand.${eng.band}`)}
              </Badge>
            </span>
          );
        },
      },
      {
        key: 'last_activity_at',
        label: t('columns.lastActivity'),
        ...MEMBERS_COLUMN_SIZES.last_activity_at,
        render: (row) => {
          const v = row.last_activity_at;
          if (!v)
            return (
              <span data-card-slot="activity" className="text-[var(--aura-fg-secondary)]">
                —
              </span>
            );
          // `<RelativeTime>` renders a stable absolute date during SSR and
          // first paint, then the relative string after hydration.
          return (
            <span data-card-slot="activity">
              <RelativeTime iso={v} title={v.replace('T', ' ').slice(0, 16)} locale={locale} />
            </span>
          );
        },
      },
      {
        key: 'actions',
        // An empty label: AURA names the header "Actions" for screen readers
        // only. The board shows the word, but the 48px menu column cannot hold
        // it without taking width from the columns that wrap.
        label: '',
        ...MEMBERS_COLUMN_SIZES.actions,
        actions: true,
        render: (row) => <RowMenu row={row} canEdit={canEdit} />,
      },
    ],
    [t, tContact, locale, enableSelection, onInlineEdit, canEdit],
  );

  return (
    <div
      // The selection checkboxes take a 24×24 target from AURA 5.11 itself
      // (WCAG 2.5.8 AA, ADOPT-01). A phone card is the board's
      // (`Admin-members-mobile`): no checkbox, no ⋯ menu, no Last activity,
      // and the fields in the board's order.
      className={`flex flex-col gap-4 ${PHONE_CARD}`}
      ref={tableContainerRef}
      // The bulk bar's Clear hands focus to this table's select-all checkbox.
      data-members-table=""
      // Record Shift on the click that toggles a checkbox; the selection
      // callback reads it to select a range. Only a click in the selection
      // column counts: a Shift-click on a row link would otherwise leave the
      // flag set for a later keyboard toggle (AURA toggles on Space, no click).
      onClickCapture={(e) => {
        const target = e.target as Element;
        shiftClickRef.current = e.shiftKey && target.closest('.aura-table__sel') !== null;
      }}
    >
      {/* Result count — a live region, so ANY filter change is announced;
          "N of M" when the full filtered total is known. Visible only while
          filtered, as on the board: unfiltered, the pagination range below
          already says it. */}
      <div
        className={filtered ? 'self-end text-xs text-[var(--aura-fg-secondary)]' : 'sr-only'}
        role="status"
      >
        <span className={filtered ? undefined : 'sr-only'}>
          {total !== undefined
            ? t('resultsCountOfTotal', { count: rows.length, total })
            : t('resultsCount', { count: rows.length })}
        </span>
      </div>
      {/* #2 cross-page "Select all N matching". Two states:
          (a) OFFER — whole visible page selected + more matching rows exist
              beyond it: clicking asks the parent to fetch the matching ids
              (capped at BULK_CAP).
          (b) ACTIVE — the parent holds the cross-page selection: show the count
              (capped copy when clamped to BULK_CAP) + a Clear. */}
      {matchingActive ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--aura-radius-md)] border border-[var(--aura-fg-accent)] bg-[var(--aura-bg-selected)] px-4 py-2 text-sm" role="status">
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
              ref={clearMatchingBtnRef}
              type="button"
              className="font-medium text-[var(--aura-fg-accent)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
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
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[var(--aura-radius-md)] border border-[var(--aura-fg-accent)] bg-[var(--aura-bg-selected)] px-4 py-2 text-sm" role="status">
            <span>{t('allPageSelected', { count: selectedCount })}</span>
            <button
              ref={selectAllMatchingBtnRef}
              type="button"
              className="font-medium text-[var(--aura-fg-accent)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
              onClick={onSelectAllMatching}
            >
              {t('selectAllMatching', { count: total ?? 0 })}
            </button>
          </div>
        )
      )}
      <AuraProvider strings={tableStrings}>
        <DataTable<MembersTableRow>
          label={t('tableCaption')}
          rows={rows}
          columns={columns}
          rowKey="member_id"
          manual
          // No `totalRows`: without a `pageSize` AURA numbers rows from 1 on
          // every page, so aria-rowcount must be the page's count too (a
          // page-3 row read as "row 2 of 132" otherwise). Sorting needs more
          // than one row on the page.
          sort={sort}
          onSortChange={handleSortChange}
          getRowHref={(row) => `/admin/members/${row.member_id}`}
          // Rows grow to fit wrapped text (a long name, a name beside its
          // badges); cells stay vertically centred.
          rowHeight="auto"
          stackBelow={640}
          {...(enableSelection
            ? {
                selectable: true,
                selected,
                onSelectionChange: handleSelectionChange,
                isRowSelectable: isMemberRowSelectable,
                rowSelectLabel: (row: MembersTableRow) =>
                  t('selectRow', { company: row.company_name }),
                rowSelectDisabledLabel: (row: MembersTableRow) =>
                  t('rowNotSelectable', { company: row.company_name }),
              }
            : {})}
        />
      </AuraProvider>
    </div>
  );
}
