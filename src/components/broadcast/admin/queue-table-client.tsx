'use client';

/**
 * T117 — the admin review queue's list: an AURA `DataTable` from `md` up, the
 * board's phone cards below it (spec 122 US12b).
 *
 * Selection (Smart-2: admins bulk-approve rows awaiting review) is AURA's own
 * per-row predicate (`isRowSelectable`, handoff item 52): only `actionable`
 * rows (`status === 'submitted'`) get a box, select-all skips the rest, and
 * managers (`readOnly`) get no selection column at all. The selection is
 * controlled here and mirrored up to `QueueWithBulk`, which owns the bulk bar:
 *   - `onSelectionChange(ids)` — fired whenever the selection changes, and
 *     re-fired (after pruning) when `rows` changes, so a row that drops out of
 *     a `router.refresh()` never leaves a phantom id in the mirror, the bar's
 *     count or a retried bulk approve (broadcast-queue-crosspr-hotfix);
 *   - `clearSelectionNonce` — bumped by the parent to clear (Clear, or a full
 *     bulk-approve success);
 *   - `reselectIds` + `reselectNonce` — bumped after a partial bulk failure so
 *     ONLY the failed rows stay selected (see `queue-with-bulk.tsx`).
 *
 * The phone cards follow board `Admin-broadcasts-mobile` (maintainer, 18 Oct):
 * no checkbox and no inline Approve / Reject — each card opens the detail page.
 *
 * The sr-only `role="status"` announcer is the list's ONE live region (FR-025):
 * permanently mounted (a region inserted with its text already in it is not
 * reliably read), it says whichever happened last — the view changing ("N
 * E-Blasts in this view, M stalled") or the selection count changing. The bulk
 * bar's visible count is deliberately not a live region.
 *
 * The parent server component pre-formats every per-row string and date; only
 * the ICU-plural announcements are translated here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DataTable, Icon, StatusPill, type DataTableColumn } from '@jirawatpyk/aura-react';
import type { BroadcastStatusTone } from '@/components/broadcast/status-badge-mapping';
import { ReviewActions } from './review-actions';
import { QueueCardList } from './queue-card-list';
import { SendTime, TimeInStage } from './queue-row-cells';

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
  Record<QueueOrder, { readonly id: 'timeInStage' | 'sendTime'; readonly direction: 'ascending' | 'descending' }>
> = {
  longest_in_stage: { id: 'timeInStage', direction: 'descending' },
  most_recent: { id: 'timeInStage', direction: 'ascending' },
  send_time: { id: 'sendTime', direction: 'ascending' },
};

// The row minimum counts each column's own minimum (stand-in until AURA #159:
// DataTable counts 160 px for every flexible column). `String.raw` keeps the
// `\_` escapes Tailwind reads in this file.
const QUEUE_TABLE_BOX = String.raw`max-md:hidden [&_.aura-table\_\_head]:min-w-[var(--queue-row-min)] [&_.aura-table\_\_row]:min-w-[var(--queue-row-min)]`;
// Actions, the last column (the header cell before AURA's end gutter, the body
// cell before its row break), takes two and a half shares of the spare width so Approve and
// Reject sit side by side on a wide grid (stand-in until AURA #162: no column weight).
const ACTIONS_COLUMN_SHARE = String.raw`[&_.aura-table\_\_th:has(+.aura-table\_\_gutter--end)]:grow-[2.5] [&_.aura-table\_\_td:has(+.aura-table\_\_break)]:grow-[2.5]`;

export type EnrichedQueueRow = {
  readonly broadcastId: string;
  readonly subject: string;
  readonly memberDisplayName: string;
  readonly actorRoleLabel: string | null;
  readonly segmentLabel: string;
  readonly recipientCount: number;
  /**
   * Type-3 (round-3) — single nullable struct so `(label, variant)` cannot
   * drift apart. Null = no badge to render.
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
  /** Spec 122 US12b — the AURA `StatusPill` tone (`getBroadcastStatusTone`). */
  readonly statusTone: BroadcastStatusTone;
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
};

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
   * the Stage pill, last activity is Time in stage's "since" line, the two
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
   * ≤ 50), when the page knows it; `null` when it does not, and then the
   * announcement says "shown" rather than claiming a total.
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
   * are no rows, so a stage change that empties the list keeps the one live
   * region below mounted (and able to say so).
   */
  readonly emptyState?: React.ReactNode;
  /** Whether rows can be selected; defaults to `!readOnly`. */
  readonly enableSelection?: boolean;
  /** Fired whenever the selection changes (and after a prune on new rows). */
  readonly onSelectionChange?: (ids: string[]) => void;
  /** Bump to clear the selection. */
  readonly clearSelectionNonce?: number;
  /** The ids to select the next time `reselectNonce` bumps (the failed rows of a partial bulk approve). */
  readonly reselectIds?: readonly string[];
  /** Bump to set the selection to exactly `reselectIds`. */
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
  const [selected, setSelected] = useState<string[]>([]);
  const tBulk = useTranslations('admin.broadcasts.queue.bulk');
  const tQueue = useTranslations('admin.broadcasts.queue');
  const selectionEnabled = enableSelection ?? !readOnly;
  const tableRef = useRef<HTMLDivElement>(null);

  const actionableIds = useMemo(
    () => rows.filter((r) => r.actionable).map((r) => r.broadcastId),
    [rows],
  );

  // Mirror the selection up, pruned to the rows that are still here and still
  // selectable: a row approved away by a `router.refresh()` must not stay in
  // the bar's count or a retried bulk approve. A prune sets state and lets the
  // effect run again; once nothing is orphaned it settles and reports.
  useEffect(() => {
    const kept = selected.filter((id) => actionableIds.includes(id));
    if (kept.length !== selected.length) {
      setSelected(kept);
      return;
    }
    onSelectionChange?.(kept);
  }, [selected, actionableIds, onSelectionChange]);

  // Parent-commanded clear (Clear, or a full bulk-approve success).
  useEffect(() => {
    if (clearSelectionNonce !== undefined) setSelected([]);
  }, [clearSelectionNonce]);

  // Parent-commanded re-select after a partial bulk failure. `reselectIds` is
  // read at bump time only — the nonce is the sole trigger.
  useEffect(() => {
    if (reselectNonce === undefined) return;
    setSelected([...(reselectIds ?? [])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reselectNonce]);

  const columns = useMemo<DataTableColumn<EnrichedQueueRow>[]>(() => {
    // F119 T117 — the FR-026 fields, in the order a reviewer scans them: who
    // and what, where it stands and whose move it is, how long it has waited,
    // when it goes out and to whom. Every FR-026 field is on the row; whose
    // turn is a line under the Stage pill (parity comments, 19 Oct), so the
    // pill has the width to stay on one line.
    // Spec 122 US12b — each column states the minimum its content needs (AURA
    // gives an unsized column 160 px, which pushed Actions off a 1,440 px
    // screen); together they fit the 871 px a 1,280 px screen leaves for the
    // columns, and the spare width on a wider one is shared out.
    const base: DataTableColumn<EnrichedQueueRow>[] = [
      {
        key: 'member',
        label: columnLabels.member,
        minWidth: 112,
        render: (row) => (
          <span className="flex flex-col [overflow-wrap:anywhere]">
            <span className="font-medium">{row.memberDisplayName}</span>
            {row.actorRoleLabel ? (
              <span className="aura-text-caption text-[var(--aura-fg-secondary)]">{row.actorRoleLabel}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'subject',
        label: columnLabels.subject,
        minWidth: 112,
        render: (row) => (
          <Link
            href={`/admin/broadcasts/${row.broadcastId}`}
            className="font-medium text-[var(--aura-fg-accent)] [overflow-wrap:anywhere] hover:underline"
          >
            {row.subject}
          </Link>
        ),
      },
      {
        key: 'status',
        label: columnLabels.status,
        minWidth: 200,
        render: (row) => (
          // A stage name too long for the column (SV) wraps inside its pill,
          // which then reads as a rounded box: a finite radius, clamped to a
          // full pill on one line (stand-in until AURA #158: a StatusPill never wraps).
          <span className="flex flex-col items-start gap-1 [&_.aura-pill]:whitespace-normal [&_.aura-pill]:rounded-[var(--aura-radius-lg)]">
            <StatusPill tone={row.statusTone}>{row.statusBadgeLabel}</StatusPill>
            {row.whoseTurnLabel !== null ? (
              <span className="aura-text-caption">
                <span className="text-[var(--aura-fg-secondary)]">{columnLabels.whoseTurn}:</span> {row.whoseTurnLabel}
              </span>
            ) : null}
            {/* FR-026 — the round: versions sent to the member so far. */}
            {row.round > 0 ? (
              <span className="aura-text-caption tabular-nums">{tQueue('row.round', { round: row.round })}</span>
            ) : null}
            {/* FR-029 — delivery results travel with the Sent stage. */}
            {row.deliverySummary !== null ? (
              <span className="aura-text-caption tabular-nums">{row.deliverySummary}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: 'timeInStage',
        label: columnLabels.timeInStage,
        minWidth: 132,
        // FR-026 — last activity (`stage_entered_at`) is the "since" line.
        render: (row) => (
          <span className="flex flex-col items-start gap-1">
            <TimeInStage row={row} />
            <span className="aura-text-caption tabular-nums">
              {tQueue('row.since', { date: row.lastActivityFormatted })}
            </span>
          </span>
        ),
      },
      {
        key: 'sendTime',
        label: columnLabels.sendTime,
        minWidth: 84,
        render: (row) => <SendTime row={row} proposedLabel={tQueue('row.proposed')} />,
      },
      {
        key: 'audience',
        label: columnLabels.audience,
        minWidth: 100,
        // The label keeps its own element, so "All members" is still a whole
        // text node to find (admin-review-queue D2b, queue-table-segment).
        render: (row) => (
          <span className="[overflow-wrap:anywhere]">
            <span>{row.segmentLabel}</span>
            {' · '}
            <span className="tabular-nums">{row.recipientCount}</span>
          </span>
        ),
      },
    ];
    if (!readOnly) {
      base.push({
        key: 'actions',
        label: columnLabels.actions,
        // Approve above Reject at 128 px (1,280 px screens); side by side
        // (~214 px) once the column takes its larger share of a wider grid.
        minWidth: 128,
        render: (row) =>
          row.actionable ? (
            <ReviewActions broadcastId={row.broadcastId} recipientCount={row.recipientCount} />
          ) : null,
      });
    }
    return base;
  }, [columnLabels, readOnly, tQueue]);

  const rowMin = `calc(${columns.reduce((sum, c) => sum + (c.width ?? c.minWidth ?? 160), 0)}px + 2 * var(--aura-space-6)${
    selectionEnabled ? ' + var(--aura-table-select-width)' : ''
  })`;

  // UX review M1 — `aria-sort` on the column the order follows. AURA sets it
  // only on a sortable column, and this list's order is the page's, not a
  // header button's (stand-in until AURA #157: a fixed sort indication on a
  // column the user cannot sort).
  useEffect(() => {
    const sortedLabel = columnLabels[SORTED_COLUMN[order].id];
    tableRef.current?.querySelectorAll<HTMLElement>('[role="columnheader"]').forEach((th) => {
      if (th.textContent?.trim() === sortedLabel) {
        th.setAttribute('aria-sort', SORTED_COLUMN[order].direction);
      } else if (th.getAttribute('aria-sort') !== 'none') {
        th.removeAttribute('aria-sort');
      }
    });
    // V2 — the bulk bar's Clear returns focus to the select-all checkbox by
    // this test id (`queue-bulk-action-bar.tsx`); AURA's header checkbox has
    // no prop for it, so it is tagged here.
    tableRef.current
      ?.querySelector<HTMLInputElement>('[role="columnheader"][aria-colindex="1"] input[type="checkbox"]')
      ?.setAttribute('data-testid', 'queue-select-all');
  });

  const bulkSelectedLabel = tBulk('selected', { count: selected.length });
  // F119 T109 (FR-025) / UX review H3 / H4 — the ONE live region: the view's
  // count (or "shown" when the page cannot know it) when the list changes, the
  // selection count when that changes. Derived during render from the previous
  // values; every announcement is a new text node (`seq` keys the span), so a
  // repeat of the same words is still heard. `stalled` counts only the red
  // badges (FR-027).
  const stalledCount = rows.filter((r) => r.ageBadge?.variant === 'red').length;
  const listKey = `${viewKey}#${rows.map((r) => r.broadcastId).join('|')}`;
  const [announced, setAnnounced] = useState({
    listKey,
    selectedCount: selected.length,
    text: '',
    seq: 0,
  });
  if (announced.listKey !== listKey || announced.selectedCount !== selected.length) {
    const listChanged = announced.listKey !== listKey;
    setAnnounced({
      listKey,
      selectedCount: selected.length,
      text: listChanged
        ? viewTotal !== null
          ? tQueue('resultsAnnouncement', { count: viewTotal, stalled: stalledCount })
          : tQueue('resultsAnnouncementShown', { count: rows.length, stalled: stalledCount })
        : selected.length > 0
          ? bulkSelectedLabel
          : '',
      seq: announced.seq + 1,
    });
  }
  // `data-testid`: the bulk bar mounts a second polite status region while a
  // selection exists, so the hook names THIS one.
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
          same number the announcer speaks; amber rows are not in it. */}
      {stalledCount > 0 ? (
        <p className="flex items-center gap-1.5 aura-text-body font-medium">
          <Icon name="circle-alert" size={16} className="shrink-0 text-[var(--aura-fg-danger)]" />
          {tQueue('stalledSummary', { count: stalledCount })}
        </p>
      ) : null}
      {/* UX review M1 — the order, said out loud for sighted users (the table
          header carries `aria-sort`; the phone cards have no header). */}
      <p className="aura-text-caption text-[var(--aura-fg-secondary)]" data-testid="queue-order-hint">
        {tQueue(ORDER_HINT_KEY[order])}
      </p>
      <div
        ref={tableRef}
        className={readOnly ? QUEUE_TABLE_BOX : `${QUEUE_TABLE_BOX} ${ACTIONS_COLUMN_SHARE}`}
        style={{ '--queue-row-min': rowMin } as React.CSSProperties}
      >
        <DataTable<EnrichedQueueRow>
          label={columnLabels.tableAria}
          rows={rows}
          columns={columns}
          rowKey="broadcastId"
          rowHeight="auto"
          bleed
          {...(selectionEnabled
            ? {
                selectable: true,
                selected,
                onSelectionChange: (keys: Array<string | number>) => setSelected(keys.map(String)),
                isRowSelectable: (row: EnrichedQueueRow) => row.actionable,
                rowSelectLabel: (row: EnrichedQueueRow) => tBulk('selectRowAria', { subject: row.subject }),
                rowSelectDisabledLabel: (row: EnrichedQueueRow) =>
                  tBulk('rowNotSelectable', { subject: row.subject }),
              }
            : {})}
        />
      </div>
      <QueueCardList rows={rows} className="md:hidden" />
    </>
  );
}
