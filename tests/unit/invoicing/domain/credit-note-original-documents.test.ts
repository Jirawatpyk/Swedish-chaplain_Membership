/**
 * `resolveCreditNoteOriginalDocuments` — which receipt (and which bill) a
 * credit note reduces, as shown on the admin + portal credit-note surfaces.
 *
 * Mirrors the number the credit-note PDF prints (issue-credit-note's
 * `receiptDocNum`): the payment-time RC/RE when the row has one, else the
 * §87 invoice number a legacy combined receipt reuses. An 088 bill has no §87
 * `document_number`, so reading that column alone showed "—" for every
 * 088 credit note.
 */
import { describe, expect, it } from 'vitest';
import { resolveCreditNoteOriginalDocuments } from '@/modules/invoicing/domain/credit-note';

describe('resolveCreditNoteOriginalDocuments', () => {
  it('088 bill: the receipt is the RC and the related document is the SC bill', () => {
    expect(
      resolveCreditNoteOriginalDocuments({
        receiptDocumentNumberRaw: 'RC-2026-000038',
        documentNumberRaw: null,
        billDocumentNumberRaw: 'SC-2026-000102',
      }),
    ).toEqual({
      receiptNumberRaw: 'RC-2026-000038',
      related: { kind: 'bill', numberRaw: 'SC-2026-000102' },
    });
  });

  it('legacy combined mode: the §87 INV number is the receipt itself', () => {
    expect(
      resolveCreditNoteOriginalDocuments({
        receiptDocumentNumberRaw: null,
        documentNumberRaw: 'INV-2026-000052',
        billDocumentNumberRaw: null,
      }),
    ).toEqual({ receiptNumberRaw: 'INV-2026-000052', related: { kind: 'combined' } });
  });

  it('as-paid combined receipt from the RC stream (no bill, no invoice) reads as combined', () => {
    expect(
      resolveCreditNoteOriginalDocuments({
        receiptDocumentNumberRaw: 'RC-2026-000041',
        documentNumberRaw: null,
        billDocumentNumberRaw: null,
      }),
    ).toEqual({ receiptNumberRaw: 'RC-2026-000041', related: { kind: 'combined' } });
  });

  it('legacy separate mode: an INV invoice plus its own receipt number', () => {
    expect(
      resolveCreditNoteOriginalDocuments({
        receiptDocumentNumberRaw: 'RC-2026-000007',
        documentNumberRaw: 'INV-2026-000010',
        billDocumentNumberRaw: null,
      }),
    ).toEqual({
      receiptNumberRaw: 'RC-2026-000007',
      related: { kind: 'invoice', numberRaw: 'INV-2026-000010' },
    });
  });

  it('no number at all (orphan / corrupt row) resolves to nothing', () => {
    expect(
      resolveCreditNoteOriginalDocuments({
        receiptDocumentNumberRaw: null,
        documentNumberRaw: null,
        billDocumentNumberRaw: null,
      }),
    ).toEqual({ receiptNumberRaw: null, related: null });
  });
});
