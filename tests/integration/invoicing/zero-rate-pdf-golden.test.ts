/**
 * 088-invoice-tax-flow-redesign (T058 / US8 / FR-025 / SC-003 / SC-008) —
 * §80/1(5) zero-rate PDF goldens (render-input level, REAL adapter + pdf-parse,
 * no DB).
 *
 * Proves:
 *   §A — a zero-rated §86/4 tax receipt at v8 carries the §80/1(5) note + the
 *        MFA certificate reference (no. + date) + VAT 0.00%; a zero-rated §86/4
 *        receipt at v7 (a pinned pre-v8 re-render) does NOT (SC-003 — the note
 *        is gated v>=8).
 *   §B — the non-tax ใบแจ้งหนี้ bill shows VAT 0.00% but NOT the §80/1(5) note
 *        (the note is §86/4-receipt-only; AS1 vs AS3).
 *   §C — a STANDARD receipt renders byte-LENGTH-identical at v7 and v8 (the v8
 *        template change is threaded ONLY on a zero-rated document, so every
 *        standard render is unaffected — SC-003 reproduce-the-original).
 *
 * Thai-shaping note: shapeThai may inject ZWSP (U+200B); Thai matchers tolerate
 * it. The load-bearing tokens are the ASCII "80/1(5)" fragment + the cert
 * number digits (mirrors footer-citation-golden.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type {
  PdfDocKind,
  PdfRenderInput,
} from '@/modules/invoicing/application/ports/pdf-render-port';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

const RX_8015 = /80\/1\(5\)/;
const CERT_NO = 'กต 0404/1234';
const CERT_NO_DIGITS = '0404/1234';
const CERT_DATE = '2026-03-10';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  return (await parser.getText()).text;
}

function makeLines(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000e8'),
      kind: 'event_fee',
      descriptionTh: 'ค่าออกบูธงานแสดงสินค้า',
      descriptionEn: 'Expo booth construction',
      unitPrice: Money.fromSatangUnsafe(1_200_000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(1_200_000n),
      position: 1,
    },
  ];
}

/** SIMULATED PII only. `zeroRate` toggles the pinned §80/1(5) treatment + cert. */
function makeInput(
  kind: PdfDocKind,
  templateVersion: number,
  opts: { zeroRate: boolean; billMode?: boolean } = { zeroRate: true },
): PdfRenderInput {
  const docR = DocumentNumber.of(opts.billMode ? 'SC' : 'RC', 2026, 7);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const zero = opts.zeroRate;
  return {
    kind,
    templateVersion,
    documentNumber: docR.value,
    issueDate: '2026-03-20',
    dueDate: '2026-04-19',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thai-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: 'Embassy of Sweden (Simulated)',
      tax_id: '0994000000001',
      address: '1 Wireless Rd, Bangkok',
      primary_contact_name: 'Sim Attaché',
      primary_contact_email: 'sim@embassy.test',
      member_number: null,
      member_number_display: null,
    },
    // 059 / PR-A Task 6b — `false` preserves this fixture's existing semantics:
    // the embassy buyer carries a `tax_id` but is modelled as a NON-registrant
    // (see the T058 §C comment below) — matching the pre-Task-6b behaviour
    // where the template read the snapshot's own (always-undefined here)
    // `buyer_is_vat_registrant` directly.
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(1_200_000n),
    // vat_treatment DRIVES the rate — a zero-rated document is 0% / 0.00.
    vatRate: zero ? VatRate.ofUnsafe('0.0000') : VatRate.ofUnsafe('0.0700'),
    vat: zero ? Money.fromSatangUnsafe(0n) : Money.fromSatangUnsafe(84_000n),
    total: zero ? Money.fromSatangUnsafe(1_200_000n) : Money.fromSatangUnsafe(1_284_000n),
    invoiceSubject: 'event',
    ...(opts.billMode ? { billMode: true } : {}),
    ...(zero
      ? {
          vatTreatment: 'zero_rated_80_1_5' as const,
          zeroRateCertNo: CERT_NO,
          zeroRateCertDate: CERT_DATE,
        }
      : {}),
  };
}

async function renderText(input: PdfRenderInput): Promise<string> {
  const { bytes } = await reactPdfRenderAdapter.render(input);
  expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  return extractPdfText(bytes);
}

describe('T058 §A — zero-rated §86/4 tax receipt renders the §80/1(5) note (v8)', () => {
  it('v8 zero-rate receipt_combined → §80/1(5) note + MFA cert ref + VAT 0.00%', async () => {
    const text = await renderText(makeInput('receipt_combined', CURRENT_TEMPLATE_VERSION));
    expect(text, 'must cite §80/1(5)').toMatch(RX_8015);
    expect(text, 'must reference the MFA cert number').toContain(CERT_NO_DIGITS);
    expect(text, 'must reference the MFA cert date').toContain(CERT_DATE);
    expect(text, 'VAT rate is 0.00%').toContain('0.00%');
  }, 60_000);

  it('v7 zero-rate receipt_combined → NO §80/1(5) note (gated v>=8; pinned re-render, SC-003)', async () => {
    const text = await renderText(makeInput('receipt_combined', 7));
    expect(text, 'v7 must NOT render the §80/1(5) note').not.toMatch(RX_8015);
    // The MFA cert ref only appears inside the (absent) note block.
    expect(text).not.toContain(CERT_NO_DIGITS);
  }, 60_000);
});

describe('T058 §B — the non-tax bill shows VAT 0% but NOT the §80/1(5) note (AS1)', () => {
  it('v8 zero-rate ใบแจ้งหนี้ (invoice + billMode) → VAT 0.00%, NO §80/1(5) note', async () => {
    const text = await renderText(
      makeInput('invoice', CURRENT_TEMPLATE_VERSION, { zeroRate: true, billMode: true }),
    );
    expect(text, 'bill shows VAT 0.00%').toContain('0.00%');
    expect(text, 'bill carries NO §80/1(5) note (§86/4-receipt only)').not.toMatch(RX_8015);
    expect(text).not.toContain(CERT_NO_DIGITS);
  }, 60_000);
});

describe('T058 §C — a STANDARD receipt is byte-length-stable at v7 and v8 (SC-003)', () => {
  it('standard receipt_combined renders identical byte length at v7 and v8', async () => {
    // The version MUST be the literal 8, not CURRENT_TEMPLATE_VERSION.
    //
    // This test's claim is about the v7→v8 ZERO-RATE change specifically: it is
    // threaded only onto a zero-rated document, so a STANDARD render is
    // byte-identical across that one bump. Passing CURRENT here silently
    // re-pointed the claim at every LATER bump too, which is not what it proves —
    // it survived v9 and v10 only by luck (neither gate touched this fixture) and
    // then legitimately broke at v11, whose TAX_ID_REGISTRANT_GATE drops the buyer
    // Tax ID line for a NON-registrant (this fixture's embassy buyer carries a
    // tax_id but no `buyer_is_vat_registrant`). Each version gate owns its own
    // byte-stability test at its own pinned pair — v11's lives in
    // tax-id-registrant-gate.integration.test.ts. (059 / PR-A Task 6a.)
    const ZERO_RATE_V = 8;
    const v7 = await reactPdfRenderAdapter.render(
      makeInput('receipt_combined', 7, { zeroRate: false }),
    );
    const v8 = await reactPdfRenderAdapter.render(
      makeInput('receipt_combined', ZERO_RATE_V, { zeroRate: false }),
    );
    // The v8 template change is threaded ONLY on a zero-rated document, so a
    // standard render is unaffected — the reproduce-the-original guarantee.
    expect(v8.bytes.byteLength).toBe(v7.bytes.byteLength);
    const v8Text = await extractPdfText(v8.bytes);
    expect(v8Text, 'a standard receipt never carries the §80/1(5) note').not.toMatch(RX_8015);
  }, 90_000);
});
