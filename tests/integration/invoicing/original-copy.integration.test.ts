/**
 * 088-invoice-tax-flow-redesign — T024 [US2] Original + Copy on the §86/4
 * tax receipt (FR-004 / SC-004 / §105ทวิ คู่ฉบับ).
 *
 * A `receipt_combined` (ใบกำกับภาษี/ใบเสร็จรับเงิน) MUST render as TWO pages in
 * ONE PDF — page 1 ต้นฉบับ / ORIGINAL, page 2 สำเนา / COPY — sharing ONE RC
 * document number and stored as ONE artifact (one render, one sha, one blob).
 *
 * Home = integration (node env): the assertion imports `@react-pdf/renderer`
 * (Node-oriented) and — for the byte-level SC-004 confirmation — the real
 * render adapter (font registration is heavyweight, matching the other
 * `tests/integration/invoicing/*golden*` renders). No live Neon is touched.
 *
 * The primary structural assertion traverses the `InvoiceTemplate` element
 * tree (deterministic, no PDF parser): `@react-pdf/renderer` maps exactly one
 * PDF page per `<Page>` element, so counting `<Page>` children under the single
 * `<Document>` is a faithful proxy for "pages in the PDF". A second test then
 * confirms the ORIGINAL + COPY markers survive into the REAL rendered bytes.
 *
 * SC-003 (byte-determinism): the two-page render is gated on
 * `templateVersion >= 4` (bumped CURRENT_TEMPLATE_VERSION). A pinned pre-v4
 * `receipt_combined` (historical / resend / void-overlay re-render) still
 * paginates to a single page — asserted below — so already-issued documents
 * reproduce byte-for-length-stable.
 */
import { describe, it, expect } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Document, Page } from '@react-pdf/renderer';
import { PDFParse } from 'pdf-parse';
import { InvoiceTemplate } from '@/modules/invoicing/infrastructure/pdf/templates/invoice-template';
import { shapeThai } from '@/modules/invoicing/infrastructure/pdf/fonts/register-sarabun';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfDocKind, PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const RC_RAW = 'RC-2026-000042';
const ORIGINAL_MARKER = shapeThai('ต้นฉบับ / ORIGINAL');
const COPY_MARKER = shapeThai('สำเนา / COPY');

function makeLines(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000a1'),
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก ปี 2026',
      descriptionEn: 'Membership 2026',
      unitPrice: Money.fromSatangUnsafe(100_000n),
      quantity: '1.0000',
      proRateFactor: '1.0000',
      total: Money.fromSatangUnsafe(100_000n),
      position: 1,
    },
  ];
}

function makeInput(
  kind: PdfDocKind,
  templateVersion: number,
  voidUnderlyingKind?: 'invoice' | 'receipt_combined' | 'receipt_separate',
): PdfRenderInput {
  const docR = DocumentNumber.of('RC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind,
    templateVersion,
    // exactOptionalPropertyTypes — only set the optional field when provided.
    ...(voidUnderlyingKind ? { voidUnderlyingKind } : {}),
    documentNumber: docR.value,
    issueDate: '2026-04-18',
    dueDate: '2026-05-18',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'Acme Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'John Doe',
      primary_contact_email: 'john@acme.example',
      member_number: null,
      member_number_display: null,
    },
    // 059 / PR-A Task 6b — irrelevant to this file's subject (page count /
    // ORIGINAL+COPY markers); `true` matches the fixture's own `tax_id`.
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

/** Recursively collect every string/number leaf under a React node. */
function collectText(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (isValidElement(node)) {
    return collectText((node.props as { children?: ReactNode }).children);
  }
  return [];
}

/** The `<Page>` children of the single `<Document>` returned by the template. */
function pagesOf(el: ReactElement): ReactElement[] {
  expect(el.type).toBe(Document);
  return Children.toArray((el.props as { children?: ReactNode }).children).filter(
    (c): c is ReactElement => isValidElement(c) && c.type === Page,
  );
}

/** Joined text of one page (separator keeps distinct leaves from fusing). */
function pageText(page: ReactElement): string {
  return collectText(page).join('');
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  return (await parser.getText()).text;
}

describe('088 US2 — receipt_combined renders Original + Copy (FR-004 / SC-004)', () => {
  it('AS1 (structure): receipt_combined@v4 → ONE Document, TWO pages — page 1 ต้นฉบับ/ORIGINAL, page 2 สำเนา/COPY, same RC on both', () => {
    const pages = pagesOf(InvoiceTemplate(makeInput('receipt_combined', 4)));
    expect(pages).toHaveLength(2);

    const original = pageText(pages[0]!);
    const copy = pageText(pages[1]!);

    // Page 1 = Original (ต้นฉบับ / ORIGINAL), never COPY.
    expect(original).toContain('ORIGINAL');
    expect(original).toContain(ORIGINAL_MARKER);
    expect(original).not.toContain('COPY');

    // Page 2 = Copy (สำเนา / COPY), never the ORIGINAL marker.
    expect(copy).toContain('COPY');
    expect(copy).toContain(COPY_MARKER);
    expect(copy).not.toContain('ORIGINAL');

    // Both pages carry the SAME single RC tax number (§105ทวิ คู่ฉบับ).
    expect(original).toContain(RC_RAW);
    expect(copy).toContain(RC_RAW);
  });

  it('contrast: receipt_separate@v4 stays ONE page with NO Copy (§105 legal identity unchanged — FR-006)', () => {
    const pages = pagesOf(InvoiceTemplate(makeInput('receipt_separate', 4)));
    expect(pages).toHaveLength(1);
    expect(pageText(pages[0]!)).not.toContain('COPY');
  });

  it('contrast: invoice@v4 stays ONE page (scope guard — only receipt_combined paginates)', () => {
    const pages = pagesOf(InvoiceTemplate(makeInput('invoice', 4)));
    expect(pages).toHaveLength(1);
    expect(pageText(pages[0]!)).not.toContain('COPY');
  });

  it('SC-003 version gate: a pinned pre-v4 receipt_combined@v3 still renders ONE page (historical docs unchanged)', () => {
    const pages = pagesOf(InvoiceTemplate(makeInput('receipt_combined', 3)));
    expect(pages).toHaveLength(1);
    expect(pageText(pages[0]!)).not.toContain('COPY');
  });

  it('review fix (void symmetry): a VOID of receipt_combined@v4 keeps TWO pages — the §105ทวิ Copy is NOT dropped from the cancellation evidence (kind=void_stamped_invoice, voidUnderlyingKind=receipt_combined)', () => {
    const pages = pagesOf(
      InvoiceTemplate(makeInput('void_stamped_invoice', 4, 'receipt_combined')),
    );
    expect(pages).toHaveLength(2);
    // The retained คู่ฉบับ cancellation evidence mirrors its 2-page original +
    // its 2-page CREDITED re-render: page 1 ต้นฉบับ, page 2 สำเนา, same RC on both
    // (the VOID `fixed` watermark repeats across the คู่ฉบับ).
    expect(pageText(pages[0]!)).toContain(ORIGINAL_MARKER);
    expect(pageText(pages[1]!)).toContain(COPY_MARKER);
    expect(pageText(pages[0]!)).toContain(RC_RAW);
    expect(pageText(pages[1]!)).toContain(RC_RAW);
  });

  it('SC-003 (void gate): a VOID of a pinned pre-v4 receipt_combined@v3 stays ONE page (matches the 1-page doc it cancels)', () => {
    const pages = pagesOf(
      InvoiceTemplate(makeInput('void_stamped_invoice', 3, 'receipt_combined')),
    );
    expect(pages).toHaveLength(1);
  });

  it('SC-004 (bytes): the REAL adapter render of receipt_combined@v4 carries BOTH ORIGINAL + COPY + one RC number; receipt_separate@v4 has no COPY', async () => {
    const combined = await reactPdfRenderAdapter.render(makeInput('receipt_combined', 4));
    const text = await extractPdfText(combined.bytes);
    expect(text).toContain('ORIGINAL');
    expect(text).toContain('COPY');
    expect(text).toContain(RC_RAW);

    const separate = await reactPdfRenderAdapter.render(makeInput('receipt_separate', 4));
    const separateText = await extractPdfText(separate.bytes);
    expect(separateText).not.toContain('COPY');
  }, 60_000);
});
