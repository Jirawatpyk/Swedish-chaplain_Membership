/**
 * `PipelineTable` — the F8 renewal pipeline, one AURA `DataTable`.
 *
 * 122 US7a (T702; Clarifications, Session 2026-09-30 US7 start): one table
 * that stacks into cards below 640px, replacing the TanStack table and the
 * separate phone card list. Selection, row actions and the lifted dialogs
 * work from the same rows. Paging, filtering and sorting stay on the server
 * and in the URL (FR-015): the table is `manual`, and a sortable header
 * navigates to the page's precomputed sort href.
 *
 * Columns follow the `Admin-renewals` board: Tier, Company, Expires,
 * Urgency, Last reminder, Status, Invoice and Actions. The phone card
 * (`Admin-renewals-mobile`) is titled by the company with the urgency pill;
 * the invoice column leaves the card, and the row actions take a full-width
 * row at its end (see `row-actions.tsx`).
 *
 * `canMutate` (admin) gates the row's money and mutation affordances ("Send
 * reminder", "Mark paid", "Record payment on invoice"); "Open" and "Mark
 * contacted" stay for a manager (see `row-actions.tsx`).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AuraProvider,
  DataTable,
  type DataTableColumn,
  type DataTableSort,
} from '@jirawatpyk/aura-react';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import { BillIssuedBadge } from '@/components/renewals/bill-issued-badge';
import { isPastDeadlineUrgency } from '@/components/renewals/urgency';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import { RelativeTime } from '@/components/shell/relative-time';
import { OutreachDialog } from './outreach-dialog';
import { MarkPaidOfflineDialog } from './mark-paid-offline-dialog';
import {
  RowActions,
  usePipelineEmptyCopy,
  type OutreachTarget,
  type MarkPaidTarget,
} from './row-actions';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { CycleStatus, PipelineRow, PipelineSort } from '@/modules/renewals/client';
import { PIPELINE_COLUMN_LAYOUT } from './pipeline-table-columns';

export interface PipelineTableProps {
  readonly rows: ReadonlyArray<PipelineRow>;
  /**
   * `true` for `admin`, `false` for a read-only `manager`. Gates the row's
   * MUTATION affordances (both 403 for a manager at the route). Required:
   * every caller states its actor's role rather than defaulting to admin.
   */
  readonly canMutate: boolean;
  /** When set, the empty state reads "No members renew in {month}" (month lens). */
  readonly monthLabel?: string;
  /**
   * Discriminates the month-lens empty copy — `overdue`/`later` get
   * dedicated strings (deferred fix-wave-2 #4). Absent keeps the
   * `monthLabel`-only behaviour.
   */
  readonly monthKind?: 'overdue' | 'later' | 'month';
  /** The active server-side sort; drives `aria-sort` on the Tier / Expires headers. */
  readonly sort?: PipelineSort;
  /**
   * Precomputed header sort hrefs (built in the page so they keep
   * `tier`/`urgency`/`month`, toggle the direction and drop the paging
   * `cursor`). Absent ⇒ no header is sortable.
   */
  readonly sortHrefs?: Record<'expires' | 'tier', string>;
  /** Sighted result-count caption, rendered directly above the rows. */
  readonly resultCount?: React.ReactNode;
  /** Admin-only row selection (feeds `PipelineWithBulk`'s bulk bar). */
  readonly enableSelection?: boolean;
  /** Receives the selected cycleIds (the row key), NOT memberIds. */
  readonly onSelectionChange?: (cycleIds: string[]) => void;
  /** Bumped by the parent (`PipelineWithBulk`) to clear the selection. */
  readonly clearSelectionNonce?: number;
}

/** The grid's column key for each sortable column. */
const SORT_COLUMN = { tier: 'tierBucket', expires: 'expiresAt' } as const;

function toDataTableSort(sort: PipelineSort | undefined): DataTableSort | null {
  switch (sort) {
    case 'expires_at_asc':
      return { key: SORT_COLUMN.expires, dir: 'asc' };
    case 'expires_at_desc':
      return { key: SORT_COLUMN.expires, dir: 'desc' };
    case 'tier_asc':
      return { key: SORT_COLUMN.tier, dir: 'asc' };
    case 'tier_desc':
      return { key: SORT_COLUMN.tier, dir: 'desc' };
    default:
      return null;
  }
}

export function PipelineTable({
  rows,
  canMutate,
  monthLabel,
  monthKind,
  sort,
  sortHrefs,
  resultCount,
  enableSelection = false,
  onSelectionChange,
  clearSelectionNonce,
}: PipelineTableProps) {
  const t = useTranslations('admin.renewals.table');
  const router = useRouter();
  const empty = usePipelineEmptyCopy(monthKind, monthLabel);

  // Lifted from the row menu so the dialogs outlive it closing; each target
  // carries the row's ⋯ trigger as `finalFocus`. The mark-paid dialog falls
  // back to `#main-content` when a settlement's refresh unmounts the row.
  const [outreachFor, setOutreachFor] = useState<OutreachTarget | null>(null);
  const [markPaidFor, setMarkPaidFor] = useState<MarkPaidTarget | null>(null);

  // ── Selection (admin only), keyed by cycleId ────────────────────────────
  const [selected, setSelected] = useState<string[]>([]);
  const commitSelection = useCallback(
    (next: string[]) => {
      setSelected(next);
      onSelectionChange?.(next);
    },
    [onSelectionChange],
  );
  const handleSelectionChange = useCallback(
    (keys: Array<string | number>) => commitSelection(keys.map(String)),
    [commitSelection],
  );
  // A parent Clear bumps the nonce: the boxes clear during that render, and
  // the parent hears the empty selection after it. On a CHANGE only, never
  // on mount.
  const [seenClearNonce, setSeenClearNonce] = useState(clearSelectionNonce);
  if (clearSelectionNonce !== seenClearNonce) {
    setSeenClearNonce(clearSelectionNonce);
    setSelected([]);
  }
  const reportedClearNonceRef = useRef(clearSelectionNonce);
  useEffect(() => {
    if (clearSelectionNonce !== reportedClearNonceRef.current) {
      reportedClearNonceRef.current = clearSelectionNonce;
      onSelectionChange?.([]);
    }
  }, [clearSelectionNonce, onSelectionChange]);

  // ── Sort: the URL is the source of truth ────────────────────────────────
  // AURA cycles asc → desc → unsorted; the URL contract never unsorts, so
  // only WHICH header was clicked matters (a null means the active one).
  const tableSort = toDataTableSort(sort);
  const activeSortKey = tableSort?.key;
  const handleSortChange = useCallback(
    (next: DataTableSort | null) => {
      if (!sortHrefs) return;
      const key = next?.key ?? activeSortKey;
      if (key === SORT_COLUMN.tier) router.push(sortHrefs.tier);
      else if (key === SORT_COLUMN.expires) router.push(sortHrefs.expires);
    },
    [sortHrefs, activeSortKey, router],
  );
  const sortable = sortHrefs !== undefined;

  const columns = useMemo<DataTableColumn<PipelineRow>[]>(
    () => [
      {
        key: SORT_COLUMN.tier,
        label: t('columns.tier'),
        ...PIPELINE_COLUMN_LAYOUT.tierBucket,
        sortable,
        render: (row) => <CycleTierCell tier={row.tierBucket} />,
      },
      {
        key: 'companyName',
        label: t('columns.company'),
        ...PIPELINE_COLUMN_LAYOUT.companyName,
        render: (row) => (
          <CycleCompanyCell
            memberId={row.memberId}
            companyName={row.companyName}
            emailUnverified={row.emailUnverified}
          />
        ),
      },
      {
        key: SORT_COLUMN.expires,
        label: t('columns.expires'),
        ...PIPELINE_COLUMN_LAYOUT.expiresAt,
        sortable,
        render: (row) => <CycleExpiresCell expiresAt={row.expiresAt} />,
      },
      {
        // 0309 — an early renewal bill keeps the countdown pill (access
        // stays full until expiry); the badge says the bill is already out.
        key: 'urgency',
        label: t('columns.urgency'),
        ...PIPELINE_COLUMN_LAYOUT.urgency,
        render: (row) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            <UrgencyPill urgency={row.urgency} />
            <BillIssuedBadge
              status={row.status}
              urgency={row.urgency}
              linkedInvoiceId={row.linkedInvoiceId}
            />
          </span>
        ),
      },
      {
        // `<RelativeTime>` renders an absolute date on the server and flips
        // to relative time after hydration (no SSR/CSR text mismatch).
        key: 'lastReminderAt',
        label: t('columns.lastReminder'),
        ...PIPELINE_COLUMN_LAYOUT.lastReminderAt,
        render: (row) =>
          row.lastReminderAt ? (
            <RelativeTime
              iso={row.lastReminderAt}
              className="tabular-nums text-[var(--aura-fg-secondary)]"
            />
          ) : (
            <span className="text-[var(--aura-fg-secondary)]">—</span>
          ),
      },
      {
        key: 'status',
        label: t('columns.status'),
        ...PIPELINE_COLUMN_LAYOUT.status,
        render: (row) => (
          <span className="text-[var(--aura-fg-secondary)]">
            {/* The template-literal type tracks CycleStatus, so a new status
                is a compile error rather than a missed translation. */}
            {t(`status.${row.status}` as `status.${CycleStatus}`)}
          </span>
        ),
      },
      {
        key: 'linkedInvoiceId',
        label: t('columns.invoice'),
        ...PIPELINE_COLUMN_LAYOUT.linkedInvoiceId,
        render: (row) =>
          row.linkedInvoiceId ? (
            <Link
              href={`/admin/invoices/${row.linkedInvoiceId}`}
              className="text-[var(--aura-fg-accent)] hover:underline"
            >
              {t('viewInvoice')}
            </Link>
          ) : row.anchored && !isPastDeadlineUrgency(row.urgency) ? (
            // plan-change-ux seam 1(b) — the period is already COVERED
            // (rolling anchor) but no RENEWAL invoice is linked yet: coverage
            // language that asserts no payment status, so the cell is never
            // read as "payment owed" beside a countdown pill. `title` for
            // mouse users, the `sr-only` span for everyone else; text, not
            // colour alone, carries the meaning (WCAG 1.4.1). Gated to
            // PRE-EXPIRY urgency (059 covered-gate fix): once a cycle is
            // suspended/terminated a renewal is owed, so it falls to "—".
            <span
              className="font-medium text-[var(--aura-fg-positive)]"
              title={t('invoiceCoveredTitle')}
            >
              {t('invoiceCoveredLabel')}
              <span className="sr-only"> — {t('invoiceCoveredTitle')}</span>
            </span>
          ) : (
            <span className="text-[var(--aura-fg-secondary)]">—</span>
          ),
      },
      {
        // An empty label: AURA names the header "Actions" for screen readers.
        key: 'actions',
        label: '',
        ...PIPELINE_COLUMN_LAYOUT.actions,
        render: (row) => (
          <RowActions
            cycleId={row.cycleId}
            memberId={row.memberId}
            companyName={row.companyName}
            status={row.status}
            linkedInvoiceId={row.linkedInvoiceId}
            canMutate={canMutate}
            onRecordOutreach={setOutreachFor}
            onMarkPaid={setMarkPaidFor}
          />
        ),
      },
    ],
    [t, canMutate, sortable],
  );

  const tableStrings = useMemo(() => ({ selectAllRows: t('selectAll') }), [t]);

  return (
    // One block, so the page's pipeline gap treats the table as a unit; the
    // result-count caption sits directly above the rows it describes.
    <div className="flex flex-col gap-[var(--aura-space-2)]">
      {/* The caption is built on the server and arrives as a resolved node;
          a keyed fragment keeps React from reading it as an unkeyed list
          child beside the table. */}
      <Fragment key="result-count">{resultCount}</Fragment>
      <AuraProvider strings={tableStrings}>
        <DataTable<PipelineRow>
          label={t('tableCaption')}
          rows={rows}
          columns={columns}
          rowKey="cycleId"
          manual
          sort={tableSort}
          onSortChange={handleSortChange}
          rowHeight="auto"
          stackBelow={640}
          // Edge to edge inside the list card from 640px up (AURA 5.27, #130);
          // the bulk bar and "Next 50" can follow, so it does not end the card.
          bleed
          empty={empty}
          {...(enableSelection
            ? {
                selectable: true,
                rangeSelect: true,
                selected,
                onSelectionChange: handleSelectionChange,
                // An empty company would read "Select " (M-3).
                rowSelectLabel: (row: PipelineRow) =>
                  row.companyName
                    ? t('selectRow', { company: row.companyName })
                    : t('selectRowGeneric'),
              }
            : {})}
        />
      </AuraProvider>
      {outreachFor ? (
        <OutreachDialog
          open
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
          finalFocus={outreachFor.finalFocus}
        />
      ) : null}
      {markPaidFor ? (
        <MarkPaidOfflineDialog
          open
          onOpenChange={(open) => {
            if (!open) setMarkPaidFor(null);
          }}
          cycleId={markPaidFor.cycleId}
          companyName={markPaidFor.companyName}
          finalFocus={markPaidFor.finalFocus}
        />
      ) : null}
    </div>
  );
}
