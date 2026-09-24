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
 * bulk-approve them (catalogue Feature #7).
 *
 * Task 6 (2026-08-01-broadcast-review-queue-pr2) — selection ownership
 * moved OUT of this component. `rowSelection` stays local/uncontrolled
 * (TanStack needs somewhere to hold it), but a parent (`QueueWithBulk`)
 * now mirrors it via three new optional props:
 *   - `enableSelection` (defaults to `!readOnly`, the pre-Task-6 gate) —
 *     whether the `select` column renders at all. (F119 T109: the sr-only
 *     announcer no longer follows it — it is mounted for every viewer.)
 *   - `onSelectionChange(ids)` — fired in an effect whenever the local
 *     `rowSelection` changes, so the parent always has the current
 *     broadcastId list. Cross-PR hotfix (broadcast-queue-crosspr-hotfix):
 *     also re-fires (and prunes `rowSelection`) when `rows` changes without
 *     a selection toggle, so a row dropping out of a `router.refresh()` no
 *     longer leaves a stale/phantom id in the mirror or the checkbox state
 *     — see the comment above the mirror effect below.
 *   - `clearSelectionNonce` — bumped by the parent to force this
 *     component's uncontrolled selection back to `{}` (e.g. after Clear
 *     or a full bulk-approve success). Mirrors the members-directory
 *     `DirectoryWithBulk`/`MembersTable` nonce precedent.
 * The OLD sticky-top `role="region"` bulk bar + its `handleBulkApprove`
 * fan-out are DELETED from this file — that UI + logic now live in the
 * fixed-bottom `QueueBulkActionBar` (Task 5), mounted by `QueueWithBulk`
 * alongside this table. The sr-only `role="status"` selection announcer
 * STAYS here (see the comment above `selectionAnnouncer` below) and is the
 * SOLE live region for the count — the bar's visible count span is
 * deliberately NOT a live region, so this permanently-mounted announcer
 * covers the mount/unmount 0↔1 transitions the round-2 a11y fix exists for
 * without a double-announce.
 *
 * The parent server component pre-formats every per-row + column-header
 * i18n string and locale-formatted date, so this component never needs
 * `getTranslations` or a locale instance for row/column content. The
 * selection-announcer string (`admin.broadcasts.queue.bulk.selected`) is
 * the one exception — it's translated client-side via `useTranslations`
 * so the ICU-plural count interpolates correctly.
 */
import { useEffect, useMemo, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
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
import { QueueCardList } from './queue-card-list';
import { EmptySentinel, SendTime, TimeInStage } from './queue-row-cells';

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'ghost';

/** UX review M1 — the visible hint for each order. */
const ORDER_HINT_KEY = {
  longest_in_stage: 'order.longestInStage',
  most_recent: 'order.mostRecent',
  send_time: 'order.sendTime',
} as const satisfies Record<QueueOrder, string>;

/**
 * UX review M1 — the column each order follows, and its `aria-sort`. Longest
 * in stage first is Time in stage DESCENDING; most recent first is the
 * shortest time in stage first, so ASCENDING.
 */
const SORTED_COLUMN: Readonly<
  Record<QueueOrder, { readonly id: string; readonly direction: 'ascending' | 'descending' }>
> = {
  longest_in_stage: { id: 'timeInStage', direction: 'descending' },
  most_recent: { id: 'timeInStage', direction: 'ascending' },
  send_time: { id: 'sendTime', direction: 'ascending' },
};

/** UX review M1 — the text cells that wrap (capped) rather than widen the table. */
const WRAPPED_COLUMNS: ReadonlySet<string> = new Set(['member', 'timeInStage', 'sendTime', 'audience']);

export interface EnrichedQueueRow {
  readonly broadcastId: string;
  readonly subject: string;
  readonly memberDisplayName: string;
  readonly actorRoleLabel: string | null;
  readonly segmentLabel: string;
  readonly recipientCount: number;
  /**
   * Type-3 (round-3) — single nullable struct so `(label, variant)`
   * cannot drift apart. Null = no badge to render.
   *
   * F119 T117 / T118 — re-based on `stage_entered_at` and applied to EVERY
   * waiting stage (`stageAgeOf`): `red` IS the stalled flag (marketing-held
   * ≥ 48 h, member-held ≥ 3 days) and its label reads "Stalled — N days";
   * `amber` is the 24 h marketing pre-warning, never counted or announced
   * as stalled.
   */
  readonly ageBadge: {
    readonly label: string;
    readonly variant: 'amber' | 'red';
  } | null;
  readonly statusBadgeVariant: BadgeVariant;
  readonly statusBadgeClassName?: string;
  /** The FR-019 stage label (`approved` reads "Scheduled"). */
  readonly statusBadgeLabel: string;
  readonly actionable: boolean;
  /** F119 T117 (FR-026) — "Marketing" / "Member"; null = nobody is waiting ("—"). */
  readonly whoseTurnLabel: string | null;
  /** Time in the current stage on a waiting stage; null ("—") otherwise. */
  readonly timeInStageLabel: string | null;
  /** Versions sent to the member so far; 0 (never formatted) renders no "Round" line. */
  readonly round: number;
  readonly proposedSendAtFormatted: string | null;
  readonly confirmedSendAtFormatted: string | null;
  /** `stage_entered_at`, tenant time zone — the "since …" line under Time in stage (the row's last activity). */
  readonly lastActivityFormatted: string;
  /** F119 T119 (FR-029) — "N recipients · N delivered · …" on sent rows; null elsewhere. */
  readonly deliverySummary: string | null;
}

/**
 * UX review H1 / M1 — the order the page asked the list for, so the table can
 * say it: `aria-sort` on the column it follows, and a visible hint.
 *   - `longest_in_stage` — a view of waiting stages: time in stage, longest first;
 *   - `most_recent` — every other view: the most recent stage entry first;
 *   - `send_time` — the Upcoming sends preset: send time, soonest first.
 */
export type QueueOrder = 'longest_in_stage' | 'most_recent' | 'send_time';

export interface QueueTableClientProps {
  readonly rows: ReadonlyArray<EnrichedQueueRow>;
  /**
   * UX review M1 — eight columns (plus selection): the FR-026 fields folded
   * into fewer, wrapping cells so Actions stays reachable. Round sits under
   * the Stage badge, last activity is Time in stage's "since" line, the two
   * send times share one column, and Audience carries the recipient count.
   */
  readonly columnLabels: {
    readonly member: string;
    readonly subject: string;
    readonly status: string;
    readonly whoseTurn: string;
    readonly timeInStage: string;
    readonly sendTime: string;
    readonly audience: string;
    readonly actions: string;
    readonly select: string;
    readonly tableAria: string;
  };
  /** Defaults to `longest_in_stage` — the default Awaiting-review view's order. */
  readonly order?: QueueOrder;
  /**
   * UX review H3 — how many E-Blasts the whole VIEW holds (not the page of
   * ≤ 50), when the page knows it; `null` when it does not (a member filter or
   * the Upcoming preset narrows the per-stage counts it is summed from), and
   * then the announcement says "shown" rather than claiming a total.
   */
  readonly viewTotal?: number | null;
  /**
   * UX review H4 — the view's identity (its URL query). A change of view is
   * announced even when the rows, and so the words, are identical.
   */
  readonly viewKey?: string;
  readonly readOnly?: boolean;
  /**
   * F119 T109 — rendered in place of the table AND the card list when there
   * are no rows. It lives here, not in the server wrapper, so a stage change
   * that empties the list keeps the one live region below mounted (and able
   * to say so) instead of swapping the whole component out.
   */
  readonly emptyState?: React.ReactNode;
  /**
   * Task 6 — whether the `select` column renders (the announcer is always
   * mounted since F119 T109).
   * Defaults to `!readOnly` (the pre-Task-6 gate) when omitted, so direct
   * callers that don't opt into the selection lift (e.g. unit tests) keep
   * the original behaviour unchanged.
   */
  readonly enableSelection?: boolean;
  /** Task 6 — fired in an effect whenever the local `rowSelection` changes. */
  readonly onSelectionChange?: (ids: string[]) => void;
  /** Task 6 — bump to force the local, uncontrolled `rowSelection` to `{}`. */
  readonly clearSelectionNonce?: number;
  /**
   * Task 6 (2026-08-02-broadcast-review-queue-pr3) — the ids to re-apply as
   * `rowSelection` the next time `reselectNonce` bumps. `QueueWithBulk` uses
   * this to keep ONLY the failed rows checked after a partial bulk-approve
   * failure: because this is the SAME `rowSelection` state that backs the
   * desktop checkboxes, the mobile `QueueCardList`, and the selection
   * mirror/announcer below, re-applying it here (rather than narrowing the
   * parent's own `selectedIds` mirror in isolation) keeps every consumer of
   * the shared `useReactTable` instance in lockstep — no desync between the
   * toolbar's displayed count and the checkboxes. See `queue-with-bulk.tsx`'s
   * module docstring for why the PR2 "clear everything" acceptable-minimum
   * is replaced by this controlled re-select.
   */
  readonly reselectIds?: readonly string[];
  /** Task 6 — bump to force `rowSelection` to exactly `reselectIds`. */
  readonly reselectNonce?: number;
}

export function QueueTableClient({
  rows,
  columnLabels,
  readOnly = false,
  enableSelection,
  onSelectionChange,
  clearSelectionNonce,
  reselectIds,
  reselectNonce,
  emptyState,
  order = 'longest_in_stage',
  viewTotal = null,
  viewKey = '',
}: QueueTableClientProps): React.ReactElement {
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const tBulk = useTranslations('admin.broadcasts.queue.bulk');
  const tQueue = useTranslations('admin.broadcasts.queue');
  const selectionEnabled = enableSelection ?? !readOnly;

  const columns = useMemo<ColumnDef<EnrichedQueueRow>[]>(() => {
    const base: ColumnDef<EnrichedQueueRow>[] = [];

    // Smart-2: row-selection checkbox (admin only). Manager (`readOnly`)
    // never sees the column so the bulk-action surface is invisible to
    // read-only roles.
    if (selectionEnabled) {
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

    // F119 T117 — the FR-026 fields, in the order a reviewer scans them: who
    // and what, where it stands and whose move it is, how long it has waited,
    // when it goes out and to whom. UX review M1 folded the twelve columns
    // into eight so Actions stays on screen at 1,280-1,440 px: Round rides
    // under the Stage badge, last activity is Time in stage's "since" line,
    // the two send times share Send time, and Audience carries the recipient
    // count. Submitted left the table (it is on the detail page). Every FR-026
    // field is still on the row. The SLA badge lives on Time in stage, which is
    // what it measures (`stage_entered_at`, every waiting stage).
    base.push(
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
        id: 'status',
        header: columnLabels.status,
        cell: (ctx) => (
          <div className="flex flex-col gap-1">
            <Badge
              variant={ctx.row.original.statusBadgeVariant}
              className={cn('self-start', ctx.row.original.statusBadgeClassName)}
            >
              {ctx.row.original.statusBadgeLabel}
            </Badge>
            {/* FR-026 — the round: versions sent to the member so far. */}
            {ctx.row.original.round > 0 ? (
              <span className="text-xs tabular-nums">
                {tQueue('row.round', { round: ctx.row.original.round })}
              </span>
            ) : null}
            {/* FR-029 — delivery results travel with the Sent stage. */}
            {ctx.row.original.deliverySummary !== null ? (
              <span className="text-xs tabular-nums">
                {ctx.row.original.deliverySummary}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'whoseTurn',
        header: columnLabels.whoseTurn,
        cell: (ctx) =>
          ctx.row.original.whoseTurnLabel !== null ? (
            <span>{ctx.row.original.whoseTurnLabel}</span>
          ) : (
            <EmptySentinel />
          ),
      },
      {
        id: 'timeInStage',
        header: columnLabels.timeInStage,
        // FR-026 — last activity (`stage_entered_at`) is the "since" line: on
        // a waiting stage it dates the wait, on any other it is the only time.
        cell: (ctx) => (
          <div className="flex flex-col gap-1">
            <TimeInStage row={ctx.row.original} />
            <span className="text-xs tabular-nums">
              {tQueue('row.since', { date: ctx.row.original.lastActivityFormatted })}
            </span>
          </div>
        ),
      },
      {
        id: 'sendTime',
        header: columnLabels.sendTime,
        cell: (ctx) => <SendTime row={ctx.row.original} proposedLabel={tQueue('row.proposed')} />,
      },
      {
        id: 'audience',
        header: columnLabels.audience,
        // The label keeps its own element, so "All members" is still a whole
        // text node to find (admin-review-queue D2b, queue-table-segment).
        cell: (ctx) => (
          <span>
            <span>{ctx.row.original.segmentLabel}</span>
            {' · '}
            <span className="tabular-nums">{ctx.row.original.recipientCount}</span>
          </span>
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
  }, [columnLabels, readOnly, selectionEnabled, tQueue]);

  // Task 6 (2026-08-02-broadcast-review-queue-pr3) — the
  // `react-hooks/incompatible-library` disable that used to sit here is now
  // reported as unused: with the reselect effect below also present, the
  // React Compiler's whole-component analysis bails out on THAT effect's
  // intentionally non-exhaustive deps first and never reaches this call to
  // re-flag `useReactTable`. The underlying caveat (TanStack's returned
  // functions aren't safely memoizable) hasn't changed — this component was
  // never a React Compiler memoization candidate either way (it holds
  // uncontrolled `rowSelection` state) — only the lint tool's bailout order
  // did, so the stale disable was removed rather than left as dead comment.
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

  // Task 6 — mirror the local uncontrolled selection up to the parent
  // (`QueueWithBulk`) on every change, so the fixed-bottom
  // `QueueBulkActionBar` (which owns the bulk-approve fan-out now — see
  // module docstring) always has the current broadcastId list.
  //
  // Cross-PR hotfix (broadcast-queue-crosspr-hotfix) — the original deps
  // here were `[rowSelection, onSelectionChange, table]`. `table` is a
  // stable instance across re-renders (it mutates in place via
  // `setOptions`, it doesn't get recreated — see the comment above the
  // `useReactTable` call for why it's still not a safe ESLint
  // auto-dependency), and `onSelectionChange` is the parent's stable
  // `setSelectedIds` setter. So when `router.refresh()` drops a
  // previously-selected row out of `rows` WITHOUT any checkbox toggle
  // (e.g. the admin approves/rejects ONE row individually while others
  // stay checked, and the default view filters to `status=['submitted']`),
  // neither dep changed and this effect never re-fired: the parent mirror,
  // the toolbar count, and the confirm dialog stayed stuck on the old
  // (now-partly-absent) selection, and a bulk-approve retry would fan a
  // doomed `POST /approve` for the row that's no longer there. Adding
  // `rows` re-fires the mirror on every data change so
  // `getSelectedRowModel()` (which already intersects `rowSelection` with
  // the CURRENT row model) re-syncs the parent to only-present ids.
  //
  // That alone leaves the local `rowSelection` map itself still holding the
  // absent row's key — a phantom that would resurrect CHECKED if that row
  // ever reappears in a later refresh. Prune it here too. Guarded against a
  // render loop the same way `clearSelectionNonce`/`reselectNonce` below
  // avoid re-triggering themselves: only call `setRowSelection` when the
  // prune actually drops a key; once nothing is orphaned this branch is
  // skipped and the effect settles.
  useEffect(() => {
    const presentIds = new Set(rows.map((r) => r.broadcastId));
    const prunedEntries = Object.entries(rowSelection).filter(([id]) =>
      presentIds.has(id),
    );
    if (prunedEntries.length !== Object.keys(rowSelection).length) {
      setRowSelection(Object.fromEntries(prunedEntries));
    }
    onSelectionChange?.(
      table.getSelectedRowModel().rows.map((r) => r.original.broadcastId),
    );
  }, [rowSelection, rows, onSelectionChange, table]);

  // Task 6 — parent-commanded reset (Clear / full bulk-approve success).
  // Guarded only on the prop being defined at all — direct callers that
  // never pass `clearSelectionNonce` (e.g. unit tests) never fire this.
  useEffect(() => {
    if (clearSelectionNonce !== undefined) setRowSelection({});
  }, [clearSelectionNonce]);

  // Task 6 (2026-08-02-broadcast-review-queue-pr3) — parent-commanded
  // CONTROLLED re-select: after a partial bulk-approve failure,
  // `QueueWithBulk` bumps `reselectNonce` with `reselectIds` set to exactly
  // the failed ids. Re-applying `rowSelection` here (rather than only
  // narrowing the parent's own mirror) is what keeps the desktop checkboxes,
  // the mobile card list, and the toolbar count all reading off the SAME
  // state — no desync. `reselectIds` is deliberately read at bump time only,
  // not tracked as a dep — the nonce is the sole trigger, mirroring
  // `clearSelectionNonce` above.
  useEffect(() => {
    if (reselectNonce === undefined) return;
    setRowSelection(Object.fromEntries((reselectIds ?? []).map((id) => [id, true])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reselectNonce]);

  // Simplify-S3 (round-3) — derive in render; no useMemo + ESLint
  // suppression. Selection size is bounded by visible rows; cost is
  // negligible.
  const selectedIds = table.getSelectedRowModel().rows.map((r) => r.original.broadcastId);

  // A5 UX hardening — bulk-bar `aria-label` was the unresolved template
  // string `"{count} selected"`; SR users heard the literal placeholder.
  // Task 5 — moved to `tBulk('selected', {count})` (ICU plural) so the
  // count is both correctly interpolated AND grammatically pluralised.
  const bulkSelectedLabel = tBulk('selected', { count: selectedIds.length });
  // Round-2 review Fix 1 — the announcer is PERMANENTLY MOUNTED (not
  // conditionally rendered only while `selectedIds.length > 0`), because an
  // `aria-live` region that appears WITH its content already populated in
  // the same paint is not reliably announced by NVDA/JAWS — only text
  // MUTATIONS on an already-mounted live region are announced. That would
  // silence exactly the transitions this feature exists to announce: 0→1
  // (entering selection) and 1→0 (clearing). Task 6 — this stays here even
  // though the VISIBLE bulk bar moved to `QueueBulkActionBar` (Task 5,
  // mounted by `QueueWithBulk`): that bar's visible count span is
  // deliberately NOT a live region (it would otherwise double-announce with
  // this one), and the bar itself unmounts at the 0↔1 boundary
  // (`selectedIds.length === 0` renders `null`), so this permanently-mounted
  // announcer is the sole region covering every transition. Precedent:
  // `members-table.tsx` selected-count region + `renewals/result-count-
  // announcer.tsx`.
  //
  // F119 T109 (FR-025) — the SAME region also announces a change of the list
  // itself (a stage selected, a row approved away): "N E-Blasts in this view,
  // M stalled". Never a second region. So it is mounted for EVERY viewer —
  // a read-only manager changes stage too — and it announces whichever
  // happened last: the list changing, or the selection changing. Nothing is
  // announced on the first paint. Derived during render from the previous
  // values (React's "adjust state when a prop changes" pattern) rather than
  // in an effect with a run-once ref, which StrictMode's double mount defeats.
  // `stalled` counts ONLY the red (stalled) badges: the amber pre-warning is
  // never announced as stalled (FR-027).
  //
  // UX review H3 — the count is the VIEW's (`viewTotal`, what the stage chips
  // add up to), not the page of ≤ 50 the list holds; when the page cannot know
  // the total it says "shown". Stalled is counted on the rows shown, and says
  // so ("N stalled shown"): the stalled flag is computed per row, and a page
  // is all the rows there are here.
  //
  // UX review H4 — the list is keyed on the VIEW (`viewKey`, the URL) as well
  // as its rows, so a change of view is news even when it lands on the same
  // rows (two empty views, say). And every announcement is a NEW text node
  // (`seq` keys the span): with `aria-atomic`, replacing the node is a DOM
  // mutation a screen reader hears even when the words repeat — setting the
  // same string again changes nothing and is silent.
  const stalledCount = rows.filter((r) => r.ageBadge?.variant === 'red').length;
  const listKey = `${viewKey}#${rows.map((r) => r.broadcastId).join('|')}`;
  const [announced, setAnnounced] = useState({
    listKey,
    selectedCount: selectedIds.length,
    text: '',
    seq: 0,
  });
  if (announced.listKey !== listKey || announced.selectedCount !== selectedIds.length) {
    const listChanged = announced.listKey !== listKey;
    setAnnounced({
      listKey,
      selectedCount: selectedIds.length,
      text: listChanged
        ? viewTotal !== null
          ? tQueue('resultsAnnouncement', { count: viewTotal, stalled: stalledCount })
          : tQueue('resultsAnnouncementShown', { count: rows.length, stalled: stalledCount })
        : selectedIds.length > 0
          ? bulkSelectedLabel
          : '',
      seq: announced.seq + 1,
    });
  }
  // `data-testid`: the bulk-action bar mounts a SECOND permanently-mounted
  // polite `role="status"` announcer (`7465ae9be`) while a selection exists,
  // so a selector on the role alone resolves to two elements (e2e
  // strict-mode violation, 2026-09-10). The hook is the stable way to name
  // THIS one.
  const announcer = (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      data-testid="queue-selection-announcer"
    >
      {announced.text !== '' ? <span key={announced.seq}>{announced.text}</span> : null}
    </div>
  );

  if (rows.length === 0) {
    return (
      <>
        {announcer}
        {emptyState}
      </>
    );
  }

  return (
    <>
      {announcer}
      {/* F119 T118 — the stalled count of the rows shown: icon + text, the
          same number the announcer speaks; amber rows are not in it. UX review
          H3 — worded "shown", because it is counted on this page. */}
      {stalledCount > 0 ? (
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <AlertCircle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          {tQueue('stalledSummary', { count: stalledCount })}
        </p>
      ) : null}
      {/* UX review M1 — the order, said out loud for sighted users (the table
          header carries `aria-sort`; the phone card list has no header). */}
      <p className="text-xs text-muted-foreground" data-testid="queue-order-hint">
        {tQueue(ORDER_HINT_KEY[order])}
      </p>
      {/* Task 4 — dual-render: desktop `<table>` hidden below `md`, mobile
          `QueueCardList` hidden at/above `md`. Both read from the SAME
          `table` instance built above, so a selection made in one
          presentation is visible in the other across a breakpoint resize. */}
      <div className="hidden md:block">
        <Table aria-label={columnLabels.tableAria}>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const narrow = header.column.id === 'select';
                  const sort =
                    header.column.id === SORTED_COLUMN[order].id
                      ? SORTED_COLUMN[order].direction
                      : undefined;
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      aria-sort={sort}
                      className={cn(narrow && 'w-10')}
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
                  // F119 T119 — the Stage cell carries the delivery results on
                  // a sent row; let that line wrap under the badge instead of
                  // widening the whole table.
                  const wrapStage = cell.column.id === 'status';
                  // UX review M1 — the other text cells wrap too, each capped,
                  // so a long company name, audience label or two-line date
                  // grows the row instead of pushing Actions off screen
                  // (measured: the member column alone ran 317 px unwrapped).
                  const wrapText = WRAPPED_COLUMNS.has(cell.column.id);
                  return (
                    <TableCell
                      key={cell.id}
                      className={cn(
                        wrapSubject && 'max-w-[40ch] whitespace-normal break-words',
                        wrapStage && 'min-w-[8rem] max-w-[16rem] whitespace-normal',
                        wrapText && 'max-w-[12rem] whitespace-normal break-words',
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
      <QueueCardList
        table={table}
        readOnly={readOnly}
        columnLabels={columnLabels}
        className="md:hidden"
      />
    </>
  );
}
