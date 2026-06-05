/**
 * 054-event-fee-invoices (Task 9) — event-invoice PDF golden test.
 *
 * Pins the §86/4 doc-type render contract on the EVENT-fee PDF, end-to-end
 * through the REAL `reactPdfRenderAdapter` (decompressed text extracted via
 * pdf-parse). Two cases, both Model B (VAT-INCLUSIVE line = all-in ticket):
 *
 *   (i)  event + buyer TIN (matched-member shape) →
 *          title "ใบกำกับภาษี / Tax Invoice"
 *          event_fee line description present
 *          line amount = inclusive 1,070.00; subtotal 1,000 / VAT 70 / total 1,070
 *          "ราคารวมภาษีมูลค่าเพิ่มแล้ว / VAT included" annotation present
 *          buyer Tax ID line present
 *
 *   (ii) event + NO buyer TIN (non-member walk-in) →
 *          title "ใบเสร็จรับเงิน / Official Receipt"
 *          same amounts + VAT-included annotation
 *          NO buyer Tax ID line (the §105 receipt buyer has no TIN)
 *
 * Why a render adapter golden (not a use-case integration): the title switch
 * + VAT-included annotation live in the TEMPLATE, driven by `kind` +
 * `vatInclusive` on `PdfRenderInput`. The issue-invoice → render-input WIRING
 * (which kind is chosen from subject + buyer TIN) is pinned separately in
 * `issue-event-invoice.test.ts`. This test pins the TEMPLATE side: given the
 * input issue-invoice builds, the bytes carry the right legal labels.
 *
 * Mirrors `credit-note-pdf-golden.test.ts`'s render-spy posture but renders
 * REAL bytes because the assertion is about glyphs the template emits, not the
 * structured render-input arguments.
 *
 * No DB — pure render-input → bytes → text. Lives in tests/integration/** for
 * the live-Neon profile only because react-pdf font registration + pdf-parse
 * are heavyweight; it touches no tenant data.
 *
 * Thai-shaping note: `shapeThai` decomposes sara-am (ำ U+0E33 → ◌ํ + า) and
 * injects ZWSP break points, so extracted Thai text can differ from the i18n
 * source code point sequence. The "ใบกำกับภาษี" matcher tolerates both the
 * composed (ำ) and decomposed (ํา) forms exactly as the e2e PDF assertion does.
 */
import { describe, it, expect } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId, type InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

/** Single Model-B event_fee line — unitPrice === total === inclusive satang. */
function makeEventLine(): InvoiceLine[] {
  return [
    {
      lineId: asInvoiceLineId('00000000-0000-0000-0000-0000000000e1'),
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน Annual Gala (2026-09-10)',
      descriptionEn: 'Event: Annual Gala (2026-09-10)',
      // 1,070.00 THB inclusive — the canonical 1,000 net + 70 VAT case.
      unitPrice: Money.fromSatangUnsafe(107_000n),
      quantity: '1.0000',
      proRateFactor: null,
      total: Money.fromSatangUnsafe(107_000n),
      position: 1,
    },
  ];
}

/**
 * Build the render input exactly as `issue-invoice` does for an EVENT (Model B,
 * vatInclusive=true): the line carries the GROSS amount, subtotal/vat are the
 * back-calculated split (1,070 incl @ 7% → 1,000 net + 70 VAT).
 */
function makeEventRenderInput(opts: {
  kind: 'invoice' | 'receipt_separate';
  buyerTaxId: string | null;
}): PdfRenderInput {
  const docR = DocumentNumber.of('EVT', 2026, 7);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: opts.kind,
    templateVersion: 1,
    documentNumber: docR.value,
    issueDate: '2026-09-10',
    dueDate: '2026-09-10',
    tenant: {
      legal_name_th: 'หอการค้าไทย-สวีเดน',
      legal_name_en: 'Thailand-Swedish Chamber of Commerce',
      tax_id: '0000000000000',
      address_th: 'กรุงเทพมหานคร',
      address_en: 'Bangkok',
      logo_blob_key: null,
    },
    member: {
      legal_name: opts.buyerTaxId ? 'Beta Imports Ltd' : 'Walk-in Guest',
      tax_id: opts.buyerTaxId,
      address: '50 Sukhumvit Road, Bangkok 10110',
      primary_contact_name: 'Jane Doe',
      primary_contact_email: 'jane@beta.example',
      // 055-member-number — event buyer has no member number → no Member No. line.
      member_number: null,
    },
    lines: makeEventLine(),
    subtotal: Money.fromSatangUnsafe(100_000n), // 1,000.00 net
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n), // 70.00 VAT
    total: Money.fromSatangUnsafe(107_000n), // 1,070.00 gross
    vatInclusive: true,
  };
}

describe('054 Task 9 — event-invoice PDF golden (§86/4 doc-type render)', () => {
  it('(i) event + buyer TIN → title ใบกำกับภาษี / Tax Invoice, inclusive line + amounts + VAT-included annotation + buyer Tax ID', async () => {
    const input = makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' });
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Title — full tax invoice. Thai "ใบกำกับภาษี" may extract with sara-am
    // decomposed (ํา) per shapeThai; tolerate both forms + an optional ZWSP.
    expect(text, 'expected Thai full-tax-invoice title ใบกำกับภาษี').toMatch(
      /ใบก[ำํ]​?า?กับภาษี/,
    );
    expect(text, 'expected English "Tax Invoice"').toMatch(/Tax Invoice/i);
    // MUST NOT carry the receipt title.
    expect(text).not.toMatch(/Official Receipt/i);

    // Event_fee line description rendered (English token is sara-am-free).
    expect(text).toContain('Annual Gala');
    expect(text).toContain('2026-09-10');

    // Amounts: inclusive line 1,070.00 + back-calculated subtotal/VAT/total.
    expect(text).toContain('1070.00'); // line total === grand total (Model B)
    expect(text).toContain('1000.00'); // net subtotal
    expect(text).toContain('70.00'); // VAT

    // VAT-included annotation (English token is sara-am-free → matches verbatim).
    expect(text, 'expected "VAT included" annotation on a VAT-inclusive doc').toMatch(
      /VAT included/i,
    );

    // §86/4 — a full tax invoice carries the buyer's Tax ID.
    expect(text).toContain('9876543210123');
  }, 60_000);

  it('(ii) event + NO buyer TIN → title ใบเสร็จรับเงิน / Official Receipt, same amounts + VAT-included annotation, NO buyer Tax ID line', async () => {
    const input = makeEventRenderInput({ kind: 'receipt_separate', buyerTaxId: null });
    const { bytes } = await reactPdfRenderAdapter.render(input);
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    const text = await extractPdfText(bytes);

    // Title — §105 official receipt. "ใบเสร็จรับเงิน" has no sara-am → extracts
    // cleanly (modulo a possible trailing ZWSP, which a substring match ignores).
    expect(text, 'expected Thai receipt title ใบเสร็จรับเงิน').toContain('ใบเสร็จรับเงิน');
    expect(text, 'expected English "Official Receipt"').toMatch(/Official Receipt/i);
    // MUST NOT carry the full-tax-invoice title (a TIN-less buyer cannot get a
    // §86/4 ใบกำกับภาษี — the ship-blocker this whole task closes).
    expect(text).not.toMatch(/Tax Invoice/i);

    // Same Model-B amounts as the tax-invoice case.
    expect(text).toContain('1070.00');
    expect(text).toContain('1000.00');
    expect(text).toContain('70.00');

    // VAT-included annotation present on the receipt too (still VAT-inclusive).
    expect(text).toMatch(/VAT included/i);

    // NO buyer Tax ID line — the buyer supplied no TIN, so the template's
    // `input.member.tax_id && (...)` conditional omits it. Prove it two ways:
    //
    //   1. Positive: the buyer legal name IS present (confirms the buyer
    //      section rendered at all, making the negative conclusive).
    //
    //   2. Negative: the bare "Tax ID: …" buyer label MUST NOT appear.
    //      The seller's TIN is rendered with a Thai prefix:
    //        "เลขประจำตัวผู้เสียภาษี / Tax ID: 0000000000000"
    //      so a multiline `^Tax ID:` (line-start anchor) is buyer-specific
    //      — the seller line never starts with "Tax ID:" because the Thai
    //      prefix sits before it on the same text node. See invoice-template.tsx
    //      line 244 (seller) vs line 276 (buyer) for the two patterns.
    expect(text, 'buyer legal name must be present in the rendered receipt').toContain(
      'Walk-in Guest',
    );
    expect(
      text,
      'buyer Tax ID block MUST NOT render when tax_id is null (§86/4 receipt path)',
    ).not.toMatch(/^Tax ID:/m);
  }, 60_000);

  it('membership-style VAT-EXCLUSIVE invoice → NO VAT-included annotation (regression guard)', async () => {
    // A membership invoice is VAT-exclusive (vatInclusive omitted/false): the
    // annotation MUST NOT appear, preserving byte-identical re-render for F4.
    const input: PdfRenderInput = {
      ...makeEventRenderInput({ kind: 'invoice', buyerTaxId: '9876543210123' }),
      vatInclusive: false,
      lines: [
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
      ],
    };
    const { bytes } = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(bytes);
    expect(text).toMatch(/Tax Invoice/i);
    expect(text, 'membership (VAT-exclusive) MUST NOT show the VAT-included note').not.toMatch(
      /VAT included/i,
    );
  }, 60_000);
});
