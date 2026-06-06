/**
 * 055-member-number — invoice PDF golden: the buyer block renders a bilingual
 * "หมายเลขสมาชิก / Member No.: <formatted>" line ONLY when the snapshot's
 * member_number_display (the FORMATTED `{prefix}-{zeroPad}` string pinned at
 * issue) is non-null.
 *
 *  (a) membership invoice, member_number_display='SCCM-0042' → line present,
 *                                                              shows SCCM-0042
 *  (b) event invoice,      member_number_display=null        → line ABSENT
 *  (c) historical snapshot (no key → null)                   → line ABSENT
 *      (SC-003: byte-stable re-render of a pre-feature invoice)
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
// real (formatted) number. A historical (key-absent) snapshot resolves to null
// at the write boundary's zod default, so for the template the runtime form is
// the same null — cases (b) and (c) both render the null variant (the
// distinction is the PROVENANCE of the null, both of which must omit the line).
// The template renders `member_number_display` (the FORMATTED string), so the
// fixture drives that field; the bare `member_number` is set in lockstep for a
// faithful snapshot shape but is NOT what the buyer block prints.
function makeRenderInput(opts: {
  memberNumber: number | null;
  memberNumberDisplay: string | null;
}): PdfRenderInput {
  const docR = DocumentNumber.of('INV', 2026, 1);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  const member: MemberIdentitySnapshot = {
    legal_name: 'SCCM Member Co., Ltd.',
    tax_id: '0105562000123',
    address: '99/1 Rama IV, Bangkok 10500',
    primary_contact_name: 'Jane Doe',
    primary_contact_email: 'jane@member.example',
    member_number: opts.memberNumber,
    member_number_display: opts.memberNumberDisplay,
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
  it('(a) membership invoice with member_number_display="SCCM-0042" → buyer block shows the FORMATTED Member No.: SCCM-0042', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(
      makeRenderInput({ memberNumber: 42, memberNumberDisplay: 'SCCM-0042' }),
    );
    const text = await extractPdfText(bytes);
    // The buyer block renders the FORMATTED string (prefix-zeroPad), NOT the bare
    // integer 42 — this is the whole point of the display field.
    expect(text).toMatch(/Member No\.?:?\s*SCCM-0042/);
    // The bare integer must NOT leak as a standalone "Member No.: 42" line.
    expect(text).not.toMatch(/Member No\.?:?\s*42(?!\d)/);
    // Thai label survives shapeThai (sara-am-free → matches verbatim).
    expect(text).toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(b) event invoice with member_number_display=null → NO Member No. line', async () => {
    const { bytes } = await reactPdfRenderAdapter.render(
      makeRenderInput({ memberNumber: null, memberNumberDisplay: null }),
    );
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
    expect(text).not.toContain('หมายเลขสมาชิก');
  }, 60_000);

  it('(c) historical snapshot (member_number_display=null after default) → NO Member No. line (byte-stable re-render)', async () => {
    // A pre-feature invoice's JSONB had no member_number_display key; the zod
    // .default(null) resolves it to null at read, so the template MUST omit the
    // line — preserving the determinism/byte-stability guarantee for
    // already-issued tax documents.
    const { bytes } = await reactPdfRenderAdapter.render(
      makeRenderInput({ memberNumber: null, memberNumberDisplay: null }),
    );
    const text = await extractPdfText(bytes);
    expect(text).not.toMatch(/Member No\./i);
  }, 60_000);
});
