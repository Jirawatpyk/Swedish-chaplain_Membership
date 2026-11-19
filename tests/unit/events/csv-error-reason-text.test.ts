import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import {
  CSV_BATCH_TX_ABORTED,
  CSV_ROW_DB_ERROR,
  ERROR_CSV_REASON_TEXT,
} from '@/modules/events/application/use-cases/import-csv';

// The downloaded error CSV and the result card must say the same thing
// (#739 UX M1): the EN text the use case writes equals the EN locale copy.
describe('error CSV reason text (#739)', () => {
  const reasons = en.admin.events.import.result.errorReasons;

  it.each([
    [CSV_ROW_DB_ERROR, reasons.row_db_error],
    [CSV_BATCH_TX_ABORTED, reasons.batch_tx_aborted],
  ])('%s matches the EN result-card copy', (code, copy) => {
    expect(ERROR_CSV_REASON_TEXT[code]).toBe(copy);
  });

  it('tells the admin a re-upload is safe and uses no internal jargon', () => {
    for (const text of Object.values(ERROR_CSV_REASON_TEXT)) {
      expect(text).toContain('Upload the same file again; rows already saved are skipped.');
      expect(text).not.toMatch(/batch/i);
      expect(text).not.toContain('Not saved:');
    }
  });
});
