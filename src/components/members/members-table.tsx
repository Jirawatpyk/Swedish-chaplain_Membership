'use client';

/**
 * T065 + T108 + T112 — Members directory table.
 *
 * TanStack Table v8 headless + shadcn Table visual primitives. Rows link
 * to the detail page. The risk column (accessor id `member_risk_flag`, kept
 * stable since the F8 pre-wiring) renders the F8-derived risk band/score from
 * the row's `member_risk_flag` object (`{ score, band } | null`, sourced from
 * F3 `members.risk_score_band` populated by F8's batched recompute); when not
 * yet computed (FR-035 min-tenure) it shows a labelled tooltip explaining why
 * — see the cell renderer below, not a bare em-dash.
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
// F8 Phase 6 Wave H — risk-score badge for the directory column. F8
// shared primitive lives at src/components/renewals/risk-score-badge.tsx
// and is barrel-safe (Domain types only; no Drizzle/server imports).
import { RiskScoreBadge } from '@/components/renewals/risk-score-badge';
// Type-only import (erased at compile time → no runtime/client-bundle coupling
// to the insights server graph). The engagement value is projected server-side.
import type { EngagementBand, RiskBand } from '@/modules/insights';
// C4 round-10 ui-design-specialist — flag emoji + localised country name.
import { CountryDisplay } from './country-display';
import {
  useInlineEditField,
  type InlineSaveOutcome,
} from './use-inline-edit-field';

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
  /**
   * F8 Phase 6 Wave H — at-risk band derived from F3
   * `members.risk_score_band` (populated by F8's batched recompute
   * cron). Null when the recompute hasn't run yet (FR-035 min-tenure
   * skips fresh members) — the column then renders the "—" placeholder.
   * Kept under the legacy `member_risk_flag` accessor name for column
   * id stability across F3 → F8 transition.
   */
  readonly member_risk_flag: { score: number; band: RiskBand } | null;
  /**
   * F9 (T034 / G1) — engagement score = positive-framed inverse of the F8 risk
   * band. PROJECTED SERVER-SIDE in the members page row-mapping via the
   * canonical `projectEngagementScore`; null when unscored (mirrors
   * member_risk_flag). The cell only renders this value (no projection logic).
   */
  readonly engagement: { readonly score: number; readonly band: EngagementBand } | null;
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

  const Icon = !active ? ArrowUpDownIcon : order === 'asc' ? ArrowUpIcon : ArrowDownIcon;
  return (
    <button
      type="button"
      onClick={onSort}
      className="inline-flex items-center gap-1 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={t('sortByEngagement')}
      {...(active ? { 'aria-sort': order === 'asc' ? 'ascending' : 'descending' } : {})}
    >
      {t('columns.engagement')}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * C7 round-10 ui-design-specialist — column-header affordance for the
 * 3 editable cells (status / country / notes). Renders the label + a
 * small pencil icon; hovering / focusing the icon surfaces the
 * instruction ("Double-click any cell in this column to edit inline.
 * Enter to save, Escape to cancel."). Only mounted when the caller
 * passes `editable={true}` — manager view drops it.
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

  // Value-specific save logic (validate → onSave → toast); the shared
  // hook owns the edit/saving/flash state + the double-fire + Escape+blur
  // race guards (see use-inline-edit-field.ts).
  const commit = useCallback(
    async (draft: string, current: string): Promise<InlineSaveOutcome> => {
      const normalised = draft.trim().toUpperCase();
      if (normalised === current) return 'closed';
      if (normalised.length !== 2) {
        toast.error(t('countryInvalid'));
        return 'closed';
      }
      const result = await onSave!(memberId, 'country', normalised);
      if (result.ok) {
        toast.success(t('countryUpdated'));
        return 'saved';
      }
      // Round-3 N-I1: keep input open on error so user can retry without retyping.
      toast.error(result.error);
      return 'kept-open';
    },
    [memberId, onSave, t],
  );

  const {
    editing,
    isEditing,
    saving,
    savedFlash,
    fieldRef,
    startEdit,
    setDraft,
    handleSave,
    handleKeyDown,
  } = useInlineEditField<string, HTMLInputElement>({
    current: country,
    toDraft: (c) => c,
    commit,
    selectOnFocus: true,
  });

  if (!onSave) {
    return <span>{country}</span>;
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        onDoubleClick={startEdit}
        title={t('editCountryHint')}
        className="group inline-flex min-h-[28px] min-w-[40px] cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('editCountry')}
      >
        {/* C4 round-10 — flag-only matches the read-only manager
            view so admin/manager rows have identical width. */}
        <CountryDisplay code={country} variant="flag-only" />
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
        ref={fieldRef}
        type="text"
        value={editing ?? ''}
        maxLength={2}
        pattern="[A-Za-z]{2}"
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        className="h-7 w-14 rounded-sm border border-input bg-background px-2 text-sm uppercase focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('countryInput')}
      />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : savedFlash ? t('saved') : ''}
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

  const commit = useCallback(
    async (
      draft: string,
      current: string | null,
    ): Promise<InlineSaveOutcome> => {
      const next = draft.trim() || null;
      if (next === current) return 'closed';
      const result = await onSave!(memberId, 'notes', next);
      if (result.ok) {
        toast.success(t('notesUpdated'));
        return 'saved';
      }
      // Round-3 N-I1: keep textarea open so user doesn't lose their draft.
      toast.error(result.error);
      return 'kept-open';
    },
    [memberId, onSave, t],
  );

  const {
    editing,
    isEditing,
    saving,
    savedFlash,
    fieldRef,
    startEdit,
    setDraft,
    handleSave,
    handleKeyDown,
  } = useInlineEditField<string | null, HTMLTextAreaElement>({
    current: notes,
    toDraft: (n) => n ?? '',
    commit,
    // Shift+Enter inserts a newline; plain Enter submits.
    submitOnEnter: (e) => !e.shiftKey,
  });

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

  if (!isEditing) {
    // I5 round-10 — preview was clipped at 24 chars (notes accepts
    // 4000). Bumped to 60 so multi-sentence notes are readable
    // without entering edit mode. Full text remains available via
    // `title` tooltip for sighted users + sr-only span for SR users.
    const preview = notes ? (notes.length > 60 ? notes.slice(0, 60) + '…' : notes) : '—';
    return (
      <button
        type="button"
        onDoubleClick={startEdit}
        title={notes ?? t('editNotesHint')}
        className="group inline-flex min-h-[28px] max-w-[260px] cursor-pointer items-center gap-1 truncate rounded-md px-1 py-0.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
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
        ref={fieldRef}
        value={editing ?? ''}
        maxLength={4000}
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        className="min-h-[28px] w-48 resize-y rounded-sm border border-input bg-background px-2 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('notesInput')}
        placeholder={t('notesPlaceholder')}
      />
      <span className="sr-only" aria-live="polite">
        {saving ? t('saving') : savedFlash ? t('saved') : ''}
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
  const locale = useLocale();
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
      header: () => (
        <EditableColumnHeader
          label={t('columns.country')}
          editable={enableSelection}
        />
      ),
      cell: (info) =>
        enableSelection ? (
          <InlineCountryCell
            memberId={info.row.original.member_id}
            country={info.getValue()}
            onSave={onInlineEdit}
          />
        ) : (
          // C4 round-10 — `variant="flag-only"` per user preference:
          // ISO code redundant when the flag already identifies the
          // country. Hover/SR surfaces the localised full name.
          <CountryDisplay code={info.getValue()} variant="flag-only" />
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
    columnHelper.accessor('member_risk_flag', {
      header: () => t('columns.risk'),
      cell: (info) => {
        const flag = info.getValue();
        if (flag === null) {
          // C5 round-10 ui-design-specialist — the previous em-dash
          // placeholder + sr-only "Risk score not yet computed" made
          // sighted admins think the data was broken. Show a short
          // descriptive label + a tooltip that explains WHY (newly-
          // added members don't have a score until 30 days of activity
          // accumulate per FR-035 min-tenure rule). Cell stays compact;
          // the tooltip surfaces the rationale on hover/focus.
          // Round-11 review fix — TooltipProvider HOISTED to MembersTable
          // root (line ~770). Per-row TooltipProvider × N rows produced
          // tooltip races + Tab order noise at scale.
          return (
            <Tooltip>
              {/* T097 (F9 a11y) — no `aria-label` on this roleless <span>:
                  ARIA prohibits aria-label on a generic span (axe
                  `aria-prohibited-attr`, WCAG 4.1.2). The visible text
                  ("Not yet scored") is the accessible name and the tooltip
                  content is wired via aria-describedby, so SR users still get
                  the full "computed after 30 days" explanation. Satisfies
                  WCAG 2.5.3 Label in Name (visible text == accessible name). */}
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    className="text-xs text-muted-foreground underline decoration-dotted underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                  />
                }
              >
                {t('riskNotComputed')}
              </TooltipTrigger>
              <TooltipContent>
                {t('riskNotComputedTooltip')}
              </TooltipContent>
            </Tooltip>
          );
        }
        // F8 Phase 6 Wave H — render real RiskScoreBadge from F8 module.
        // F6 readiness gate is presentation-deferred: directory rows
        // don't carry the active_max signal so we use 100 as the
        // canonical max (production uses the F6-active formula by
        // default; F6-inactive surface 70 is widget-specific).
        return (
          <RiskScoreBadge
            score={flag.score}
            band={flag.band}
            activeMax={100}
          />
        );
      },
    }),
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
    columnHelper.accessor('notes', {
      header: () => (
        <EditableColumnHeader
          label={t('columns.notes')}
          editable={enableSelection}
        />
      ),
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
                  className={`hover:bg-accent/40 focus-within:bg-accent/40 ${
                    row.getIsSelected() ? 'bg-accent/20' : ''
                  }`}
                >
                  {row.getVisibleCells().map((cell, idx) => (
                    <TableCell key={cell.id} className="align-middle">
                      {/* First non-select column is the company name link */}
                      {!enableSelection && idx === 0 ? (
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
                      ) : enableSelection && idx === 1 ? (
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
