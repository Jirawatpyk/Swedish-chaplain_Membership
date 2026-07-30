/**
 * Pure classifier for the orphan invoice-blob sweep
 * (scripts/sweep-orphan-invoice-blobs.ts). Pins:
 *   - every real writer pattern classifies to its kind;
 *   - a foreign-tenant or unrecognised key classifies `unknown`;
 *   - verdicts: referenced beats everything; orphan requires a KNOWN
 *     pattern; unknown patterns are `unknown_kept` (never deletable);
 *   - byte totals + the referenced-missing anomaly list.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyInvoicingBlobKey,
  classifyOrphanBlobs,
} from '@/../scripts/lib/orphan-blob-classifier';

const T = 'swecham';
const U1 = '11111111-2222-3333-4444-555555555555';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const INVOICE_PDF = `invoicing/${T}/2026/${U1}_v3.pdf`;
const RECEIPT_PDF = `invoicing/${T}/2026/${U1}_receipt_v3.pdf`;
const CN_PDF = `invoicing/${T}/2026/credit-note_${U2}_v2.pdf`;
const ZERO_RATE = `invoicing/${T}/zero-rate-certs/${U1}_1753859000000.pdf`;
const LOGO = `invoicing/${T}/logos/${U2}.png`;

describe('classifyInvoicingBlobKey', () => {
  it('classifies every real writer pattern', () => {
    expect(classifyInvoicingBlobKey(INVOICE_PDF, T)).toBe('invoice_pdf');
    expect(classifyInvoicingBlobKey(RECEIPT_PDF, T)).toBe('receipt_pdf');
    expect(classifyInvoicingBlobKey(CN_PDF, T)).toBe('credit_note_pdf');
    expect(classifyInvoicingBlobKey(ZERO_RATE, T)).toBe('zero_rate_cert');
    expect(classifyInvoicingBlobKey(LOGO, T)).toBe('logo');
  });

  it('receipt/credit-note are matched BEFORE the generic invoice shape (shared `<fy>/…_v<n>.pdf` suffix)', () => {
    // If the invoice regex ran first these would misclassify as invoice_pdf.
    expect(classifyInvoicingBlobKey(RECEIPT_PDF, T)).not.toBe('invoice_pdf');
    expect(classifyInvoicingBlobKey(CN_PDF, T)).not.toBe('invoice_pdf');
  });

  it('a DIFFERENT tenant prefix classifies unknown (never deletable) — the list prefix already scopes, this is defence-in-depth', () => {
    expect(
      classifyInvoicingBlobKey(`invoicing/other-tenant/2026/${U1}_v1.pdf`, T),
    ).toBe('unknown');
  });

  it('unrecognised shapes classify unknown (e.g. the pre-versioned seed shape without `_v<n>`)', () => {
    expect(classifyInvoicingBlobKey(`invoicing/${T}/2026/${U1}.pdf`, T)).toBe(
      'unknown',
    );
    expect(classifyInvoicingBlobKey(`invoicing/${T}/stray.txt`, T)).toBe(
      'unknown',
    );
  });
});

describe('classifyOrphanBlobs', () => {
  it('referenced > orphan > unknown_kept, with byte totals for the orphan set', () => {
    const report = classifyOrphanBlobs(
      T,
      [
        { key: INVOICE_PDF, sizeBytes: 100 }, // referenced
        { key: RECEIPT_PDF, sizeBytes: 200 }, // orphan (known pattern, unreferenced)
        { key: CN_PDF, sizeBytes: 400 }, // orphan
        { key: `invoicing/${T}/stray.txt`, sizeBytes: 800 }, // unknown_kept
      ],
      new Set([INVOICE_PDF]),
    );
    expect(report.rows.map((r) => r.verdict)).toEqual([
      'referenced',
      'orphan',
      'orphan',
      'unknown_kept',
    ]);
    expect(report.listedCount).toBe(4);
    expect(report.listedBytes).toBe(1500);
    expect(report.referencedCount).toBe(1);
    expect(report.orphanCount).toBe(2);
    expect(report.orphanBytes).toBe(600);
    expect(report.unknownKeptCount).toBe(1);
  });

  it('a referenced key with an UNKNOWN pattern reports referenced (reference wins — never orphaned)', () => {
    const odd = `invoicing/${T}/2026/${U1}.pdf`;
    const report = classifyOrphanBlobs(T, [{ key: odd, sizeBytes: 1 }], new Set([odd]));
    expect(report.rows[0]?.verdict).toBe('referenced');
    expect(report.orphanCount).toBe(0);
  });

  it('reports DB-referenced keys ABSENT from the listing (anomaly list, sorted)', () => {
    const report = classifyOrphanBlobs(
      T,
      [{ key: INVOICE_PDF, sizeBytes: 1 }],
      new Set([INVOICE_PDF, ZERO_RATE, LOGO]),
    );
    expect(report.referencedMissing).toEqual([ZERO_RATE, LOGO].sort());
  });

  it('empty listing → empty report, no throws', () => {
    const report = classifyOrphanBlobs(T, [], new Set());
    expect(report.listedCount).toBe(0);
    expect(report.orphanCount).toBe(0);
    expect(report.referencedMissing).toEqual([]);
  });
});
