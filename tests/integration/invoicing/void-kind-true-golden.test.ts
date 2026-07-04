/**
 * 064 W1 Fix 3 (S31) — kind-true VOID re-render golden (adapter-level,
 * no DB).
 *
 * The VOID overlay re-render previously hardcoded the shared template's
 * DEFAULT title (ใบกำกับภาษี / Tax Invoice) regardless of what the
 * original document was — voiding a legacy §105 ใบเสร็จรับเงิน
 * (`pdf_doc_kind='receipt_separate'`) re-rendered it as a VOID-stamped
 * TAX INVOICE, mutating the legal identity of the retained §87/3
 * evidence copy. The OPTIONAL `voidUnderlyingKind` render-input field
 * lets the void variant title the document by what it actually was,
 * keeping the VOID watermark.
 *
 * ADDITIVE-CLAIM proof (SC-003 safe, no template-version bump):
 *   - When the field is ABSENT the template falls through to the
 *     historical default title path — pre-change output is preserved.
 *   - Byte-identical sha256 across renders is NOT achievable with
 *     @react-pdf/renderer v4 even for the same input (the library
 *     randomises the compressed font-subset stream — the documented
 *     T017 known limitation in pdf-deterministic.test.ts; the repo
 *     standard is STRUCTURAL equivalence: byte-length + text). The
 *     additive claim was therefore MEASURED on 2026-06-11 (Node
 *     22.22.2) as: absent-field render of the fixture below = 23310
 *     bytes with identical extracted text BEFORE and AFTER the
 *     template change (pre-change capture:
 *     docs/Bug/064-w1-void-prechange-text.txt).
 *   - The committed assertions pin the structural standard (in-run
 *     length-equality + title text), which is the part a future
 *     template edit could silently break.
 */
import { describe, expect, it } from 'vitest';
import { PDFParse } from 'pdf-parse';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  const result = await parser.getText();
  return result.text;
}

/** Fixture mirrors pdf-deterministic.test.ts makeInput — SIMULATED PII only. */
function makeVoidInput(): PdfRenderInput {
  const docR = DocumentNumber.of('SC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind: 'void_stamped_invoice',
    templateVersion: 1,
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
      legal_name: 'Simulated Void Co., Ltd.',
      tax_id: '1234567890123',
      address: '99/1 Sukhumvit Rd',
      primary_contact_name: 'Sim Contact',
      primary_contact_email: 'sim@void.test',
      member_number: null,
      member_number_display: null,
    },
    lines: [
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
    ],
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
    voidReason: 'golden probe — additive-claim measurement',
  };
}

describe('S31 — kind-true VOID title (adapter golden)', () => {
  it('absent voidUnderlyingKind — structurally deterministic AND keeps the pre-change Tax-Invoice title', async () => {
    const input = makeVoidInput();
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    // Repo structural-equivalence standard (T017 known limitation: the
    // font-subset stream randomness makes sha-identity unattainable;
    // byte LENGTH is input-deterministic and is what Blob-cache keys
    // rely on).
    expect(b.bytes.byteLength).toBe(a.bytes.byteLength);
    expect(Buffer.from(a.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');

    const text = await extractPdfText(a.bytes);
    expect(text).toMatch(/Tax Invoice/i);
    expect(text).not.toMatch(/Official Receipt/i);
    expect(text).toMatch(/VOID/);
  }, 120_000);

  it('voidUnderlyingKind=receipt_separate — keeps the §105 receipt title + VOID mark, never Tax Invoice', async () => {
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      voidUnderlyingKind: 'receipt_separate',
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    expect(text, 'expected Thai receipt title ใบเสร็จรับเงิน').toContain('ใบเสร็จรับเงิน');
    expect(text, 'expected English "Official Receipt"').toMatch(/Official Receipt/i);
    // A §105 receipt original must NEVER come back titled as a tax invoice.
    expect(text).not.toMatch(/Tax Invoice/i);
    // The VOID watermark is kept.
    expect(text).toMatch(/VOID/);
  }, 120_000);

  it('voidUnderlyingKind=receipt_combined — keeps the combined dual title + VOID mark', async () => {
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      voidUnderlyingKind: 'receipt_combined',
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    expect(text).toMatch(/Tax Invoice \/ Official Receipt/i);
    expect(text).toMatch(/VOID/);
  }, 120_000);

  it('088 T068 — voidUnderlyingKind=invoice + billMode — a voided ใบแจ้งหนี้ bill keeps the non-tax bill title, NEVER "Tax Invoice"', async () => {
    // A new-flow bill carries voidUnderlyingKind='invoice' (its pdf_doc_kind)
    // — identical to a legacy §86/4 void — so `billMode` disambiguates the two.
    // Spec § F.3: a voided bill re-renders under ใบแจ้งหนี้, never "Tax Invoice".
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      voidUnderlyingKind: 'invoice',
      billMode: true,
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    expect(text, 'expected Thai bill title ใบแจ้งหนี้').toContain('ใบแจ้งหนี้');
    // The non-tax bill must NEVER read as a §86/4 tax invoice.
    expect(text).not.toMatch(/Tax Invoice/i);
    expect(text).not.toContain('ใบกำกับภาษี');
    // The VOID watermark is kept.
    expect(text).toMatch(/VOID/);
  }, 120_000);

  it('088 T068 — billMode WITHOUT the bill void kind is inert: a legacy §86/4 void (billMode absent) still reads Tax Invoice', async () => {
    // Regression guard: the new title branch requires BOTH billMode===true AND
    // voidUnderlyingKind==='invoice'. A legacy §86/4 void passes neither
    // (billMode absent) → default ใบกำกับภาษี / Tax Invoice title unchanged.
    const legacyVoid = await reactPdfRenderAdapter.render(makeVoidInput());
    const legacyText = await extractPdfText(legacyVoid.bytes);
    expect(legacyText).toMatch(/Tax Invoice/i);
    expect(legacyText).not.toContain('ใบแจ้งหนี้');
  }, 120_000);

  it('voidUnderlyingKind=invoice — extracted text is IDENTICAL to the absent-field render (explicit value adds no content drift)', async () => {
    // Bytes legitimately differ (the extra JSON key changes the
    // deterministic font-subset seed); the CONTENT must not.
    const absent = await reactPdfRenderAdapter.render(makeVoidInput());
    const explicit = await reactPdfRenderAdapter.render({
      ...makeVoidInput(),
      voidUnderlyingKind: 'invoice',
    });
    const absentText = await extractPdfText(absent.bytes);
    const explicitText = await extractPdfText(explicit.bytes);
    expect(explicitText).toBe(absentText);
  }, 120_000);

  // ---- 088 T068 FIX 1 (H-1): vatInclusive preserved on the VOID copy ----
  it('088 T068 H-1 — void render with vatInclusive=true keeps the "VAT included" annotation (SC-003 fidelity of an event as-paid VOID copy)', async () => {
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      voidUnderlyingKind: 'receipt_separate',
      vatInclusive: true,
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    expect(text).toMatch(/VAT included/i);
    expect(text).toMatch(/VOID/);
  }, 120_000);

  // ---- 088 T068 FIX 2 (M-2): §80/1(5) note gated off the VOIDED bill ----
  it('088 T068 M-2 — voided zero-rate ใบแจ้งหนี้ bill (billMode) does NOT print the §80/1(5) note', async () => {
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      templateVersion: 8,
      voidUnderlyingKind: 'invoice',
      billMode: true,
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'MFA-2026-000042',
      zeroRateCertDate: '2026-03-01',
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    // FR-001 — a non-tax ใบแจ้งหนี้ bill carries NO §-citation, even voided.
    expect(text).not.toMatch(/VAT 0% under Revenue Code 80\/1\(5\)/i);
    expect(text).not.toMatch(/MFA certificate no\./i);
    // It is still a bill + still VOID.
    expect(text).toContain('ใบแจ้งหนี้');
    expect(text).toMatch(/VOID/);
  }, 120_000);

  it('088 T068 M-2 — voided zero-rate §86/4 RECEIPT (no billMode) STILL prints the §80/1(5) note', async () => {
    const input: PdfRenderInput = {
      ...makeVoidInput(),
      templateVersion: 8,
      voidUnderlyingKind: 'receipt_combined',
      vatTreatment: 'zero_rated_80_1_5',
      zeroRateCertNo: 'MFA-2026-000042',
      zeroRateCertDate: '2026-03-01',
    };
    const out = await reactPdfRenderAdapter.render(input);
    const text = await extractPdfText(out.bytes);
    // The tax receipt MUST keep its legal §80/1(5) basis note on the VOID copy.
    expect(text).toMatch(/VAT 0% under Revenue Code 80\/1\(5\)/i);
    expect(text).toMatch(/MFA certificate no\.: MFA-2026-000042/i);
    expect(text).toMatch(/VOID/);
  }, 120_000);
});
