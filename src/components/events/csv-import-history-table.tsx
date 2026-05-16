/**
 * T044 (F6.1 · Feature 013 — Phase 5 US5) — CSV import history table.
 *
 * Pure presentational component rendering paginated history rows from
 * `GET /api/admin/events/import/history`. Uses shadcn `<Table>`
 * primitives + lightweight client-side state (no TanStack Table needed
 * — sorting/filtering is server-driven via query params).
 *
 * Columns: Uploaded · Event · Actor · Source · Outcome · Counts ·
 * Actions (Download error CSV when available).
 *
 * Accessibility:
 *   - Outer `<Table>` exposes `role="table"` + aria-label.
 *   - Download button uses min-h-11 WCAG 2.5.8 target.
 *   - Disabled "Expired" state uses `aria-disabled` + tooltip-style
 *     title attribute.
 *   - Pagination nav is `<nav aria-label>` with prev/next buttons.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Download, FileX2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface CsvImportHistoryRow {
  readonly recordId: string;
  readonly uploadedAt: string;
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
   * Server-side URL builder for pagination links — keeps the component
   * pure and lets the server component own search-params shape.
   */
  readonly pageHref: (page: number) => string;
  /** Locale-formatted timestamp (e.g. `Intl.DateTimeFormat` on the server). */
  readonly formatTimestamp: (isoString: string) => string;
}

export function CsvImportHistoryTable({
  rows,
  pagination,
  pageHref,
  formatTimestamp,
}: CsvImportHistoryTableProps) {
  const t = useTranslations('admin.events.import.history');

  if (rows.length === 0) {
    // Empty-state anatomy per ux-standards.md § 3.1 — icon + title +
    // body + CTA.
    return (
      <div
        className="flex flex-col items-center gap-4 rounded-md border border-dashed p-10 text-center"
        data-testid="csv-import-history-empty"
      >
        <FileX2 className="size-12 text-muted-foreground" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="text-lg font-semibold">{t('emptyStateTitle')}</p>
          <p className="text-body text-muted-foreground">{t('emptyStateBody')}</p>
        </div>
        <Link
          href="/admin/events/import"
          className={cn(buttonVariants({ variant: 'default' }), 'min-h-11')}
        >
          {t('emptyStateCta')}
        </Link>
      </div>
    );
  }

  const from = (pagination.page - 1) * pagination.perPage + 1;
  const to = Math.min(
    pagination.totalRecords,
    pagination.page * pagination.perPage,
  );

  return (
    <div className="flex flex-col gap-4">
      <Table aria-label={t('tableAriaLabel')} data-testid="csv-import-history-table">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('columns.uploadedAt')}</TableHead>
            <TableHead scope="col">{t('columns.file')}</TableHead>
            <TableHead scope="col">{t('columns.sourceFormat')}</TableHead>
            <TableHead scope="col">{t('columns.outcome')}</TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              {t('columns.rowsProcessed')}
            </TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              {t('columns.rowsSkipped')}
            </TableHead>
            <TableHead scope="col" className="text-right tabular-nums">
              {t('columns.rowsFailed')}
            </TableHead>
            <TableHead scope="col">{t('columns.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.recordId} data-testid="csv-import-history-row">
              <TableCell className="font-mono text-caption">
                {formatTimestamp(row.uploadedAt)}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate">
                <span className="font-mono text-caption" title={row.originalFilename}>
                  {row.originalFilename}
                </span>
              </TableCell>
              <TableCell>
                <Badge
                  variant={row.sourceFormat === 'eventcreate_csv' ? 'default' : 'secondary'}
                  data-testid="csv-import-history-source-format"
                >
                  {t(`sourceFormat.${row.sourceFormat}`)}
                </Badge>
              </TableCell>
              <TableCell>
                {/* Outcome rendered as Badge with semantic variant so */}
                {/* admins can scan failures at a glance. */}
                <Badge
                  variant={row.outcome === 'completed' ? 'default' : 'destructive'}
                  data-testid="csv-import-history-outcome"
                >
                  {t(`outcome.${row.outcome}`)}
                </Badge>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.counts.processed}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.counts.skipped}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {row.counts.failed}
              </TableCell>
              <TableCell>
                {row.counts.failed === 0 ? (
                  <span className="text-caption text-muted-foreground">
                    {t('noErrorRows')}
                  </span>
                ) : row.errorCsvAvailable ? (
                  <a
                    href={`/api/admin/events/import/${row.recordId}/error-csv`}
                    className={cn(
                      buttonVariants({ variant: 'outline' }),
                      'min-h-11',
                    )}
                    aria-label={t('downloadErrorCsvAriaLabel', {
                      recordId: row.recordId.slice(0, 8),
                    })}
                    data-testid="csv-import-history-download"
                  >
                    <Download aria-hidden="true" className="mr-2 size-4" />
                    {t('downloadErrorCsv')}
                  </a>
                ) : (
                  /* aria-disabled on a span has no AT effect; the */
                  /* visible text already communicates state. */
                  <span
                    className="text-caption text-muted-foreground"
                    title={t('expiredTooltip')}
                    data-testid="csv-import-history-expired"
                  >
                    {t('expiredBadge')}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <nav
        className="flex items-center justify-between gap-2 pt-2"
        aria-label={t('pagination.navAriaLabel')}
        data-testid="csv-import-history-pagination"
      >
        <p className="text-caption text-muted-foreground">
          {t('pagination.showing', {
            from,
            to,
            totalRecords: pagination.totalRecords,
          })}
        </p>
        <div className="flex items-center gap-2">
          {pagination.page > 1 ? (
            <Link
              href={pageHref(pagination.page - 1)}
              prefetch={false}
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'min-h-11',
              )}
            >
              <ChevronLeft aria-hidden="true" className="mr-1 size-4" />
              {t('pagination.previous')}
            </Link>
          ) : (
            <Button variant="outline" className="min-h-11" disabled aria-disabled="true">
              <ChevronLeft aria-hidden="true" className="mr-1 size-4" />
              {t('pagination.previous')}
            </Button>
          )}
          <span className="text-caption tabular-nums">
            {t('pagination.pageOf', {
              page: pagination.page,
              totalPages: pagination.totalPages,
            })}
          </span>
          {pagination.page < pagination.totalPages ? (
            <Link
              href={pageHref(pagination.page + 1)}
              prefetch={false}
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'min-h-11',
              )}
            >
              {t('pagination.next')}
              <ChevronRight aria-hidden="true" className="ml-1 size-4" />
            </Link>
          ) : (
            <Button variant="outline" className="min-h-11" disabled aria-disabled="true">
              {t('pagination.next')}
              <ChevronRight aria-hidden="true" className="ml-1 size-4" />
            </Button>
          )}
        </div>
      </nav>
    </div>
  );
}
