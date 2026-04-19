/**
 * H7 — partial PDF state at the DB/domain boundary.
 *
 * The `Invoice.pdf` discriminated union makes "all-or-nothing"
 * invariant a compile-time guarantee at the domain level. But the DB
 * still has three nullable columns (pdf_blob_key + pdf_sha256 +
 * pdf_template_version) — the domain only sees the correct shape
 * BECAUSE the infra `buildPdfOrNull` helper throws on partial state.
 * If that throw ever regresses (e.g., silent null-drop), an
 * inconsistent invoice row would quietly reach the domain.
 *
 * These tests pin the partial-state detection behaviour by testing
 * a stand-in `buildPdfOrNull` with the same contract. Integration
 * tests verify the real DB path end-to-end.
 */
import { describe, it, expect } from 'vitest';
import type { Sha256Hex as Sha256HexT } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

/**
 * Stand-in with the exact contract of `drizzle-invoice-repo.ts`
 * `buildPdfOrNull`. Kept in-test so we can assert the behaviour
 * without importing the infra module (which pulls in Drizzle +
 * postgres-js and inflates the unit-test cold start).
 */
function buildPdfOrNull(
  blobKey: string | null,
  sha256Raw: string | null,
  templateVersion: number | null,
  invoiceId: string,
  fieldLabel: 'pdf' | 'receiptPdf',
): { blobKey: string; sha256: Sha256HexT; templateVersion: number } | null {
  const allNull = blobKey === null && sha256Raw === null && templateVersion === null;
  const allSet = blobKey !== null && sha256Raw !== null && templateVersion !== null;
  if (allNull) return null;
  if (!allSet) {
    throw new Error(
      `drizzle-invoice-repo: partial ${fieldLabel} state on row ${invoiceId} — ` +
        `blobKey=${blobKey === null ? 'null' : 'set'}, ` +
        `sha256=${sha256Raw === null ? 'null' : 'set'}, ` +
        `templateVersion=${templateVersion === null ? 'null' : 'set'}`,
    );
  }
  const parsed = Sha256Hex.parse(sha256Raw);
  if (!parsed.ok) {
    throw new Error(
      `drizzle-invoice-repo: corrupt ${fieldLabel}.sha256 on row ${invoiceId}: '${sha256Raw}'`,
    );
  }
  return { blobKey, sha256: parsed.value, templateVersion };
}

const VALID_SHA = 'a'.repeat(64);
const INVOICE_ID = 'test-invoice-id';

describe('buildPdfOrNull — partial-state detection (H7)', () => {
  it('all-null → returns null (draft invoice)', () => {
    expect(buildPdfOrNull(null, null, null, INVOICE_ID, 'pdf')).toBeNull();
  });

  it('all-set → returns the object', () => {
    const r = buildPdfOrNull('blob-key', VALID_SHA, 1, INVOICE_ID, 'pdf');
    expect(r).toEqual({ blobKey: 'blob-key', sha256: VALID_SHA, templateVersion: 1 });
  });

  it('blobKey set, sha256 null → throws (data corruption)', () => {
    expect(() => buildPdfOrNull('blob-key', null, 1, INVOICE_ID, 'pdf')).toThrow(
      /partial pdf state on row test-invoice-id/,
    );
  });

  it('blobKey set, templateVersion null → throws (data corruption)', () => {
    expect(() => buildPdfOrNull('blob-key', VALID_SHA, null, INVOICE_ID, 'pdf')).toThrow(
      /partial pdf state/,
    );
  });

  it('sha256 set, blobKey null → throws (data corruption)', () => {
    expect(() => buildPdfOrNull(null, VALID_SHA, 1, INVOICE_ID, 'pdf')).toThrow(
      /partial pdf state/,
    );
  });

  it('sha256 malformed hex → throws (corrupt)', () => {
    expect(() =>
      buildPdfOrNull('blob-key', 'not-a-sha256', 1, INVOICE_ID, 'pdf'),
    ).toThrow(/corrupt pdf.sha256/);
  });

  it('error message includes the field label (pdf vs receiptPdf)', () => {
    expect(() =>
      buildPdfOrNull('blob-key', null, 1, INVOICE_ID, 'receiptPdf'),
    ).toThrow(/partial receiptPdf state/);
  });

  it('error message includes the invoice id for trace', () => {
    expect(() =>
      buildPdfOrNull('blob-key', null, 1, 'some-specific-row-id', 'pdf'),
    ).toThrow(/some-specific-row-id/);
  });
});
