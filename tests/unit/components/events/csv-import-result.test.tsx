/**
 * R8.B1 / Staff R3 R068 closure — component test for `<CsvImportResult>`
 * `safetyNetFailedOpen` chip rendering.
 *
 * R7 R030 wired `safetyNetFailedOpen` end-to-end EXCEPT the form layer
 * that constructs `result: CsvImportResultPayload` from the HTTP
 * response. The contract tests at `tests/contract/events/csv-import-api.test.ts`
 * pin only the JSON wire (route response body). The render path
 * (form → component → DOM) was UNTESTED. This component test pins:
 *   1. safetyNetFailedOpen === true  → chip renders with role=status
 *      + data-testid + i18n string
 *   2. safetyNetFailedOpen === false → chip is NOT in DOM
 *   3. safetyNetFailedOpen === undefined → chip is NOT in DOM (back-compat)
 *
 * Pattern mirrors `tests/unit/components/events/csv-import-history-table.test.tsx`
 * (NextIntlClientProvider + inline minimal MESSAGES).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  CsvImportResult,
  type CsvImportResultPayload,
} from '@/components/events/csv-import-result';

// Minimal i18n messages covering the keys CsvImportResult consumes —
// the rest of the catalogue is irrelevant to the chip rendering test.
const MESSAGES = {
  admin: {
    events: {
      import: {
        result: {
          regionLabel: 'Import result',
          title: 'Import result',
          rowsProcessedLabel: 'Processed',
          rowsAlreadyImportedLabel: 'Already imported',
          rowsAlreadyImportedDescription: 'Previously committed rows',
          rowsStateChangedLabel: 'State changed',
          rowsStateChangedDescription: 'Rows whose state flipped on re-upload',
          eventsCreatedLabel: 'New events',
          eventsUpdatedLabel: 'Updated events',
          durationLabel: 'Duration',
          matchBreakdownTitle: 'Match breakdown',
          recordIdLabel: 'Reference ID',
          historyDegraded: 'History row degraded',
          auditDegraded: 'Audit trail degraded',
          safetyNetUnavailable:
            'Duplicate-protection unavailable — please verify the correct event was selected',
          errorRowsTitle: '{count, plural, one {# error row} other {# error rows}}',
          errorRowLabel: 'Row {rowNumber}',
          noErrorRows: 'All rows imported cleanly',
        },
        history: {
          downloadErrorCsv: 'Download error CSV',
          downloadErrorCsvAriaLabel: 'Download error CSV for import {recordId}',
        },
      },
      matchType: {
        member_contact: 'Member (contact)',
        member_domain: 'Member (domain)',
        member_fuzzy: 'Member (fuzzy)',
        non_member: 'Non-member',
        unmatched: 'Unmatched',
      },
    },
  },
};

const BASE_PAYLOAD: CsvImportResultPayload = {
  rowsProcessed: 5,
  rowsAlreadyImported: 0,
  eventsCreated: 0,
  eventsUpdated: 1,
  matchCounts: {
    member_contact: 3,
    member_domain: 0,
    member_fuzzy: 0,
    non_member: 1,
    unmatched: 1,
  },
  errorRows: [],
  durationMs: 1000,
  // recordId is REQUIRED for the safetyNet/history/audit chip block to
  // render at all — the entire chip cluster is wrapped in
  // `result.recordId !== undefined ?` in `csv-import-result.tsx:189`.
  // F6.1 imports always carry recordId; pin a stable test UUID here.
  recordId: '11111111-2222-4333-8444-555555555555',
};

function renderResult(overrides: Partial<CsvImportResultPayload>) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES}>
      <CsvImportResult result={{ ...BASE_PAYLOAD, ...overrides }} />
    </NextIntlClientProvider>,
  );
}

describe('R8.B1 — <CsvImportResult> safetyNetFailedOpen chip rendering', () => {
  afterEach(() => {
    cleanup();
  });

  it('safetyNetFailedOpen === true → chip renders with role="status" + i18n text', () => {
    renderResult({ safetyNetFailedOpen: true });
    const chip = screen.getByTestId('result-safety-net-unavailable');
    expect(chip).toBeDefined();
    expect(chip.getAttribute('role')).toBe('status');
    expect(chip.textContent).toContain('Duplicate-protection unavailable');
  });

  it('safetyNetFailedOpen === false → chip is NOT in DOM', () => {
    renderResult({ safetyNetFailedOpen: false });
    expect(screen.queryByTestId('result-safety-net-unavailable')).toBeNull();
  });

  it('safetyNetFailedOpen === undefined → chip is NOT in DOM (back-compat for older payloads)', () => {
    renderResult({});
    expect(screen.queryByTestId('result-safety-net-unavailable')).toBeNull();
  });

  it('chip is independent of historyDegraded + auditDegraded (multiple chips stack)', () => {
    renderResult({
      safetyNetFailedOpen: true,
      historyPersisted: false,
      auditCompletionEmitted: false,
    });
    expect(screen.getByTestId('result-safety-net-unavailable')).toBeDefined();
    expect(screen.getByTestId('result-history-degraded')).toBeDefined();
    expect(screen.getByTestId('result-audit-degraded')).toBeDefined();
  });
});
