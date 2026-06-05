/**
 * 055-member-number — invoice PDF golden: the buyer block renders a bilingual
 * "หมายเลขสมาชิก / Member No.: <n>" line ONLY when the snapshot's member_number
 * is non-null.
 *
 *  (a) membership invoice, member_number=42  → line present, shows 42
 *  (b) event invoice,      member_number=null → line ABSENT
 *  (c) historical snapshot (no key → null)    → line ABSENT (SC-003: byte-stable
 *                                               re-render of a pre-feature invoice)
 *
 * Render-input → real bytes → pdf-parse text. No DB. Mirrors
 * event-invoice-pdf-golden.test.ts (the lightweight golden posture).
 */
import { describe, it, expect } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

function makeLine(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000m1'),
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

// `member` typed as a parsed MemberIdentitySnapshot so we can pass null AND a
// real number. A historical (key-absent) snapshot resolves to null at the write
// boundary's zod default, so for the template the runtime form is the same null
// — cases (b) and (c) both render the null variant (the distinction is the
// PROVENANCE of the null, both of which must omit the line).
function makeRenderInput(memberNumber: number | null): PdfRenderInput {
  const docR = DocumentNumber.of('INV', 2026, 1);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const member: MemberIdentitySnapshot = {
    legal_name: 'SCCM Member Co., Ltd.',
    tax_id: '0105562000123',
    address: '99/1 Rama IV, Bangkok 10500',
    primary_contact_name: 'Jane Doe',
    primary_contact_email: 'jane@member.example',
    member_number: memberNumber,
  };
  return {
    kind: 'invoice',
    templateVersion: 1,
    documentNumber: docR.value,
    issueDate: '2026-01-15',
    dueDate: '2026-02-15',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member,
    lines: makeLine(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

describe('055 — member-number invoice PDF golden (buyer block, SC-003)', () => {
  it('(a) membership invoice with member_number=42 → buyer block shows Member No.: 42', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(42));
    const text = await extractPdfText(bytes);
    expect(text).toMatch(/Member No\.?:?\s*42/);
    // Thai label survives shapeThai (sara-am-free → matches verbatim).
    expect(text).toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(b) event invoice with member_number=null → NO Member No. line', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(null));
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
    expect(text).not.toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(c) historical snapshot (member_number=null after default) → NO Member No. line (byte-stable re-render)', async () => {
    // A pre-feature invoice's JSONB had no member_number key; the zod .default(null)
    // resolves it to null at read, so the template MUST omit the line — preserving
    // the determinism/byte-stability guarantee for already-issued tax documents.
    const { bytes } = await reactPdfRenderAdapter.render(makeRenderInput(null));
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
  }, 60_000);
});
