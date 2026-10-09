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
 * Pins (spec 122 US9b-2: AURA Badge tones, exposed as `data-tone`):
 *   1. `outcome:'running'`     → tone `neutral` + i18n "Running…"
 *   2. `outcome:'completed'`   → tone `success` + i18n "Completed"
 *   3. `outcome:'timeout'`     → tone `danger` (any non-completed,
 *                                 non-running outcome)
 *   4. `outcome:'partial_failure'` → tone `danger`
 *   5. `outcome:'unexpected_error'` → tone `danger`
 *
 * Mocks: i18n via NextIntlClientProvider with inline messages — keeps
 * the test deterministic without loading the full message catalogue.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

// Phase G G3 — auto-refresh polling uses `useRouter().refresh()` from
// next/navigation. The component requires an App Router context;
// vitest's jsdom env does not provide one. Mock the navigation surface
// to a no-op so the component renders in unit tests. The polling tick
// effect runs but the refresh call lands on the stub.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/admin/events/import/history',
  useSearchParams: () => new URLSearchParams(),
}));

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
          autoRefreshing: 'Auto-refreshing every 5s while imports are running',
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
    uploadedAtDisplay: '2026-05-16 14:00',
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
        prevPageHref={null}
        nextPageHref={null}
      />
    </NextIntlClientProvider>,
  );
}

describe('<CsvImportHistoryTable> Badge tone per outcome', () => {
  afterEach(() => cleanup());

  it("outcome:'running' renders a neutral badge + 'Running…' label", () => {
    renderTable([makeRow('running')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Running…');
    // In flight: neutral, so it reads neither as done nor as failed.
    expect(badge).toHaveAttribute('data-tone', 'neutral');
  });

  it("outcome:'completed' renders a success badge + 'Completed' label", () => {
    renderTable([makeRow('completed')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Completed');
    expect(badge).toHaveAttribute('data-tone', 'success');
  });

  it("outcome:'timeout' renders a danger badge + 'Timed out' label", () => {
    renderTable([makeRow('timeout')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Timed out');
    expect(badge).toHaveAttribute('data-tone', 'danger');
  });

  it("outcome:'partial_failure' renders a danger badge + 'Partial'", () => {
    renderTable([makeRow('partial_failure')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Partial');
    expect(badge).toHaveAttribute('data-tone', 'danger');
  });

  it("outcome:'unexpected_error' renders a danger badge + 'Failed'", () => {
    renderTable([makeRow('unexpected_error')]);
    const badge = screen.getByTestId('csv-import-history-outcome');
    expect(badge).toHaveTextContent('Failed');
    expect(badge).toHaveAttribute('data-tone', 'danger');
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
    expect(badges[0]).toHaveAttribute('data-tone', 'neutral');
    expect(badges[2]).toHaveAttribute('data-tone', 'danger');
  });
});
