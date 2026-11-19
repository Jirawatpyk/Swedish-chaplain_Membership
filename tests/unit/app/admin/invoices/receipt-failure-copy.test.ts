import { describe, expect, it } from 'vitest';

import { receiptFailedCopyKey } from '@/app/(staff)/admin/invoices/_lib/receipt-failure-copy';
import en from '@/i18n/messages/en.json';

describe('receiptFailedCopyKey (#739)', () => {
  it.each([
    ['render:TypeError', 'toast.receiptFailedRender'],
    ['upload:BlobError', 'toast.receiptFailedUpload'],
    ['receipt_doc_num_missing', 'toast.receiptFailedUnknown'],
    ['legacy_redacted', 'toast.receiptFailedUnknown'],
    ['', 'toast.receiptFailedUnknown'],
  ] as const)('%s → %s', (reason, key) => {
    expect(receiptFailedCopyKey(reason)).toBe(key);
  });

  it('every key is fixed copy with no placeholder for the code', () => {
    const toast = en.admin.invoices.detail.toast as Record<string, string>;
    for (const key of ['receiptFailedRender', 'receiptFailedUpload', 'receiptFailedUnknown']) {
      expect(toast[key]).toBeTruthy();
      expect(toast[key]).not.toMatch(/\{/);
    }
  });
});
