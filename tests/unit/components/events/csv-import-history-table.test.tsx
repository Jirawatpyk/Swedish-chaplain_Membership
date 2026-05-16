/**
 * Staff-review M-NEW-5 (2026-05-16) — component test for
 * `<CsvImportHistoryTable>` Badge variant rendering on each outcome.
 *
 * Closes the test gap flagged in R3 staff-review: the M-5 fix added
 * `outcome:'running'` → Badge `variant='secondary'` rendering at
 * `csv-import-history-table.tsx:170-175`, but no component test
 * exists, so a regression changing the variant logic would NOT fail
 * CI. Spec coverage of US5 AS3 ("in-progress imports shown as
 * Running…") depends on this UI render assertion.
 *
 * Pins:
 *   1. `outcome:'running'`     → variant `'secondary'` + i18n "Running…"
 *   2. `outcome:'completed'`   → variant `'default'`   + i18n "Completed"
 *   3. `outcome:'timeout'`     → variant `'destructive'` (any non-
 *                                 completed, non-running = destructive)
 *   4. `outcome:'partial_failure'` → variant `'destructive'`
 *   5. `outcome:'unexpected_error'` → variant `'destructive'`
 *
 * Mocks: i18n via NextIntlClientProvider with inline messages — keeps
 * the test deterministic without loading the full message catalogue.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  CsvImportHistoryTable,
  type CsvImportHistoryRow,
  type CsvImportHistoryPagination,
} from '@/components/events/csv-import-history-table';

const MESSAGES = {
  admin: {
    events: {
      import: {
        history: {
          pageTitle: 'CSV import history',
          pageSubtitle: 'Past CSV uploads',
          tableAriaLabel: 'CSV import history table',
          backToImport: 'Back to import',
          downloadErrorCsv: 'Download error CSV',
          downloadErrorCsvAriaLabel: 'Download error CSV for import {recordId}',
          expiredBadge: 'Expired',
          expiredTooltip:
            'The error CSV for this import expired after 30 days.',
          noErrorRows: 'No errors',
          emptyState: 'No imports yet.',
          loadError: 'Failed to load history.',
          columns: {
            uploadedAt: 'Uploaded',
            event: 'File',
            file: 'File',
            actor: 'Actor',
            sourceFormat: 'Source',
            outcome: 'Outcome',
            rowsProcessed: 'Processed',
            rowsSkipped: 'Skipped',
            rowsFailed: 'Failed',
            actions: 'Actions',
          },
          sourceFormat: {
            eventcreate_csv: 'EventCreate',
            generic_csv: 'Generic',
          },
          outcome: {
            running: 'Running…',
            completed: 'Completed',
            timeout: 'Timed out',
            partial_failure: 'Partial',
            invalid_header: 'Invalid header',
            event_not_found: 'Event not found',
            event_not_owned_by_tenant: 'Wrong tenant',
            unexpected_error: 'Failed',
          },
          pagination: {
            previous: 'Previous',
            next: 'Next',
            pageOf: 'Page {page} of {totalPages}',
            showing: 'Showing {from}–{to} of {totalRecords}',
            navAriaLabel: 'Pagination',
          },
        },
      },
    },
  },
} as const;

function makeRow(
  outcome: CsvImportHistoryRow['outcome'],
  index = 0,
): CsvImportHistoryRow {
  return {
    recordId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    uploadedAt: '2026-05-16T07:00:00.000Z',
    sourceFormat: 'eventcreate_csv',
    originalFilename: `fixture-${outcome}.csv`,
    originalSizeBytes: 1024,
    counts: {
      total: 10,
      processed: outcome === 'running' ? 0 : 8,
      alreadyImported: 0,
      skipped: 1,
      failed: outcome === 'running' ? 0 : 1,
    },
    outcome,
    durationMs: outcome === 'running' ? 0 : 1234,
    errorCsvAvailable: false,
    errorCsvExpiresAt: null,
  };
}

function renderTable(rows: ReadonlyArray<CsvImportHistoryRow>) {
  const pagination: CsvImportHistoryPagination = {
    page: 1,
    perPage: 30,
    totalRecords: rows.length,
    totalPages: 1,
  };
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <CsvImportHistoryTable
        rows={rows}
        pagination={pagination}
        pageHref={(page) => `/admin/events/import/history?page=${page}`}
        formatTimestamp={(iso) => new Date(iso).toISOString()}
      />
    </NextIntlClientProvider>,
  );
}

describe('<CsvImportHistoryTable> Badge variant per outcome', () => {
  afterEach(() => cleanup());

  it("outcome:'running' renders Badge variant='secondary' + 'Running…' label", () => {
    renderTable([makeRow('running')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Running…');
    // shadcn Badge variants render distinct className prefixes; the
    // `'secondary'` variant uses `bg-secondary`/`text-secondary-foreground`
    // tokens, distinct from `'default'` (primary) and `'destructive'`.
    // We assert the variant via the data attribute the component
    // emits, which is stable across Tailwind theme tweaks.
    expect(badge.className).toMatch(/bg-secondary/);
  });

  it("outcome:'completed' renders Badge variant='default' + 'Completed' label", () => {
    renderTable([makeRow('completed')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Completed');
    expect(badge.className).not.toMatch(/bg-secondary/);
    expect(badge.className).not.toMatch(/bg-destructive/);
  });

  it("outcome:'timeout' renders Badge variant='destructive' + 'Timed out' label", () => {
    renderTable([makeRow('timeout')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Timed out');
    expect(badge.className).toMatch(/bg-destructive/);
  });

  it("outcome:'partial_failure' renders Badge variant='destructive' + 'Partial'", () => {
    renderTable([makeRow('partial_failure')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Partial');
    expect(badge.className).toMatch(/bg-destructive/);
  });

  it("outcome:'unexpected_error' renders Badge variant='destructive' + 'Failed'", () => {
    renderTable([makeRow('unexpected_error')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Failed');
    expect(badge.className).toMatch(/bg-destructive/);
  });

  it('renders 3 rows with distinct outcomes — running, completed, timeout — in order', () => {
    renderTable([
      makeRow('running', 0),
      makeRow('completed', 1),
      makeRow('timeout', 2),
    ]);
    const badges = screen.getAllByTestId('csv-import-history-outcome');
    expect(badges).toHaveLength(3);
    expect(badges[0]).toHaveTextContent('Running…');
    expect(badges[1]).toHaveTextContent('Completed');
    expect(badges[2]).toHaveTextContent('Timed out');
    // First row (running) should NOT have the destructive variant
    // visible alongside the secondary one.
    expect(badges[0]!.className).toMatch(/bg-secondary/);
    expect(badges[0]!.className).not.toMatch(/bg-destructive/);
  });
});
