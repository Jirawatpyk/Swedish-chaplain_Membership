/**
 * T044 (F6.1 · Feature 013 — Phase 5 US5) — CSV import history table.
 *
 * Pure presentational component rendering paginated history rows from
 * `GET /api/admin/events/import/history`. Spec 122 US9b-2: AURA
 * `DataTable` (a card per import below 640px); paging stays server-driven
 * through the two pre-built neighbour links.
 *
 * Columns: Uploaded · File · Source · Outcome · Counts · Actions
 * (Download error CSV when available).
 *
 * Accessibility:
 *   - The grid is named by `tableAriaLabel`.
 *   - The download link uses a 44px target on touch.
 *   - Pagination nav is `<nav aria-label>` with prev/next links.
 */
'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Icon,
  buttonClass,
  type DataTableColumn,
  type Tone,
} from '@jirawatpyk/aura-react';

export interface CsvImportHistoryRow {
  readonly recordId: string;
  readonly uploadedAt: string;
  /**
   * Pre-formatted display string for `uploadedAt` (locale + Asia/Bangkok
   * TZ). Staff-review T060 follow-up (2026-05-16): function props from
   * a Server Component to a Client Component are rejected at the RSC
   * boundary in Next.js 15+ App Router ("Functions cannot be passed
   * directly to Client Components"). Pre-format on the server, pass
   * the resulting string here. The component renders this verbatim.
   */
  readonly uploadedAtDisplay: string;
  readonly sourceFormat: 'eventcreate_csv' | 'generic_csv';
  readonly originalFilename: string;
  readonly originalSizeBytes: number;
  readonly counts: {
    readonly total: number;
    readonly processed: number;
    readonly alreadyImported: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly outcome:
    // Staff-review M-5 (2026-05-16): 'running' placeholder for in-flight
    // imports — rendered as "Running…" badge per US5 AS3. Flipped to a
    // terminal outcome by `updateOutcome` at use-case end.
    | 'running'
    | 'completed'
    | 'timeout'
    | 'partial_failure'
    | 'invalid_header'
    | 'event_not_found'
    | 'event_not_owned_by_tenant'
    | 'unexpected_error';
  readonly durationMs: number;
  readonly errorCsvAvailable: boolean;
  readonly errorCsvExpiresAt: string | null;
}

export interface CsvImportHistoryPagination {
  readonly page: number;
  readonly perPage: number;
  readonly totalRecords: number;
  readonly totalPages: number;
}

interface CsvImportHistoryTableProps {
  readonly rows: ReadonlyArray<CsvImportHistoryRow>;
  readonly pagination: CsvImportHistoryPagination;
  /**
   * Pre-built href for the previous-page Link, or `null` when already on
   * page 1. Staff-review T060 follow-up (2026-05-16): replaces the prior
   * `pageHref: (page) => string` function prop that violated the RSC
   * Server→Client boundary. The Server Component builds these strings
   * during render and passes them as serializable values.
   */
  readonly prevPageHref: string | null;
  /** Pre-built href for the next-page Link, or `null` on the last page. */
  readonly nextPageHref: string | null;
}

/** Outcome tone: done reads as success, in flight as neutral, anything else failed. */
function outcomeTone(outcome: CsvImportHistoryRow['outcome']): Tone {
  if (outcome === 'completed') return 'success';
  if (outcome === 'running') return 'neutral';
  return 'danger';
}

export function CsvImportHistoryTable({
  rows,
  pagination,
  prevPageHref,
  nextPageHref,
}: CsvImportHistoryTableProps) {
  const t = useTranslations('admin.events.import.history');
  const router = useRouter();

  // Phase G G3 — auto-refresh while any row is in 'running' state. The
  // use-case flips 'running' → terminal outcome on completion; without
  // polling, the admin must manually reload to see the result. Poll
  // every 5s for up to 2 minutes (24 ticks) — long-running imports
  // beyond that warrant a manual reload, which keeps the polling cost
  // bounded.
  //
  // Round 2 R2-I6 hardening — a visible polling chip + an aria-live
  // region so the auto-refresh is not silent (WCAG 4.1.3). The live
  // region is always mounted; its content varies on `hasRunningRow`.
  //
  // Scaling concern (NEW-S2): if N admin tabs open simultaneously, N ×
  // poll rate. At SweCham scale (~3 staff) bounded fine. Post-F6.1 if
  // traffic scales to >5 concurrent admin sessions, adopt the
  // BroadcastChannel leader-election pattern at
  // `src/app/(member)/portal/invoices/[invoiceId]/_components/optimistic-paid.ts:64-71`
  // to elect one tab as the poller; others subscribe silently.
  const hasRunningRow = rows.some((r) => r.outcome === 'running');
  useEffect(() => {
    if (!hasRunningRow) return;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
      router.refresh();
      if (ticks >= 24) clearInterval(interval);
    }, 5000);
    return () => clearInterval(interval);
  }, [hasRunningRow, router]);

  const columns = useMemo<DataTableColumn<CsvImportHistoryRow>[]>(
    () => [
      {
        key: 'uploadedAtDisplay',
        label: t('columns.uploadedAt'),
        width: 176,
        render: (row) => (
          <span className="aura-text-mono">{row.uploadedAtDisplay}</span>
        ),
      },
      {
        key: 'originalFilename',
        label: t('columns.file'),
        card: 'title',
        render: (row) => (
          <span className="aura-text-mono [overflow-wrap:anywhere]" title={row.originalFilename}>
            {row.originalFilename}
          </span>
        ),
      },
      {
        key: 'sourceFormat',
        label: t('columns.sourceFormat'),
        width: 128,
        render: (row) => {
          const tone: Tone = row.sourceFormat === 'eventcreate_csv' ? 'accent' : 'neutral';
          return (
            <Badge
              tone={tone}
              data-tone={tone}
              data-testid="csv-import-history-source-format"
            >
              {t(`sourceFormat.${row.sourceFormat}`)}
            </Badge>
          );
        },
      },
      {
        key: 'outcome',
        label: t('columns.outcome'),
        width: 144,
        card: 'pill',
        render: (row) => {
          const tone = outcomeTone(row.outcome);
          return (
            <Badge
              tone={tone}
              data-tone={tone}
              data-testid="csv-import-history-outcome"
            >
              {t(`outcome.${row.outcome}`)}
            </Badge>
          );
        },
      },
      {
        key: 'processed',
        label: t('columns.rowsProcessed'),
        width: 104,
        render: (row) => <span className="tabular-nums">{row.counts.processed}</span>,
      },
      {
        key: 'skipped',
        label: t('columns.rowsSkipped'),
        width: 96,
        render: (row) => <span className="tabular-nums">{row.counts.skipped}</span>,
      },
      {
        key: 'failed',
        label: t('columns.rowsFailed'),
        width: 88,
        render: (row) => <span className="tabular-nums">{row.counts.failed}</span>,
      },
      {
        key: 'actions',
        label: t('columns.actions'),
        card: 'footer',
        render: (row) =>
          row.counts.failed === 0 ? (
            <span className="aura-text-caption text-[var(--aura-fg-secondary)]">
              {t('noErrorRows')}
            </span>
          ) : row.errorCsvAvailable ? (
            <a
              href={`/api/admin/events/import/${row.recordId}/error-csv`}
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
              aria-label={t('downloadErrorCsvAriaLabel', {
                recordId: row.recordId.slice(0, 8),
              })}
              data-testid="csv-import-history-download"
            >
              <Icon name="download" />
              {t('downloadErrorCsv')}
            </a>
          ) : (
            /* aria-disabled on a span has no AT effect; the */
            /* visible text already communicates state. */
            <span
              className="aura-text-caption text-[var(--aura-fg-secondary)]"
              title={t('expiredTooltip')}
              data-testid="csv-import-history-expired"
            >
              {t('expiredBadge')}
            </span>
          ),
      },
    ],
    [t],
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        bordered
        icon="file-text"
        title={t('emptyStateTitle')}
        description={t('emptyStateBody')}
        data-testid="csv-import-history-empty"
        action={
          <Link href="/admin/events/import" className={buttonClass({ variant: 'primary' })}>
            {t('emptyStateCta')}
          </Link>
        }
      />
    );
  }

  const from = (pagination.page - 1) * pagination.perPage + 1;
  const to = Math.min(
    pagination.totalRecords,
    pagination.page * pagination.perPage,
  );

  return (
    <div className="flex flex-col gap-[var(--aura-space-3)]">
      {/* R2-I6 — stable outer mount of the polling indicator (see above). */}
      <div
        className="flex min-h-[1.5rem] items-center justify-end gap-[var(--aura-space-2)]"
        aria-live="polite"
        aria-atomic="true"
      >
        {hasRunningRow ? (
          <span
            className="aura-text-caption flex items-center gap-[var(--aura-space-1)] text-[var(--aura-fg-secondary)]"
            data-testid="csv-import-history-auto-refresh"
          >
            <Icon name="loader-circle" size={12} className="animate-spin motion-reduce:animate-none" />
            {t('autoRefreshing')}
          </span>
        ) : null}
      </div>
      <div data-testid="csv-import-history-table">
        <DataTable<CsvImportHistoryRow>
          label={t('tableAriaLabel')}
          rows={[...rows]}
          columns={columns}
          rowKey="recordId"
          rowHeight="auto"
          stackBelow={640}
        />
      </div>

      <nav
        className="flex flex-wrap items-center justify-between gap-[var(--aura-space-2)]"
        aria-label={t('pagination.navAriaLabel')}
        data-testid="csv-import-history-pagination"
      >
        <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
          {t('pagination.showing', {
            from,
            to,
            totalRecords: pagination.totalRecords,
          })}
        </p>
        <div className="flex items-center gap-[var(--aura-space-2)]">
          {prevPageHref !== null ? (
            <Link
              href={prevPageHref}
              prefetch={false}
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
            >
              <Icon name="chevron-left" />
              {t('pagination.previous')}
            </Link>
          ) : (
            <Button variant="secondary" size="sm" icon="chevron-left" touchHeight disabled>
              {t('pagination.previous')}
            </Button>
          )}
          <span className="aura-text-caption tabular-nums">
            {t('pagination.pageOf', {
              page: pagination.page,
              totalPages: pagination.totalPages,
            })}
          </span>
          {nextPageHref !== null ? (
            <Link
              href={nextPageHref}
              prefetch={false}
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
            >
              {t('pagination.next')}
              <Icon name="chevron-right" />
            </Link>
          ) : (
            <Button variant="secondary" size="sm" iconRight="chevron-right" touchHeight disabled>
              {t('pagination.next')}
            </Button>
          )}
        </div>
      </nav>
    </div>
  );
}
