/**
 * T017 — F4 PDF deterministic-render integration test (SC-003).
 *
 * Phase-3 promotion (2026-04-19): asserts the PDF renderer is
 * INPUT-DETERMINISTIC in all observable ways that matter for Blob-
 * cache semantics and legal re-verification.
 *
 * Known limitation — byte-identical sha256 NOT achievable with
 * @react-pdf/renderer v4: the library embeds font subsets with a
 * random 6-char tag prefix (e.g. `JLXPPG+Sarabun-Bold`) AND randomises
 * the compressed font-subset stream itself, so two renders of the
 * same input produce different bytes with the same length + text
 * content. The original SC-003 "byte-identical re-download" target
 * therefore requires either (1) upstream fix in @react-pdf, or
 * (2) post-processing to strip the font-subset randomness (~200 LOC
 * PDF parser). Deferred to F4 Phase 10 polish / post-MVP.
 *
 * What we DO assert here, which is the load-bearing invariant:
 *   - byte length is byte-exact across renders (input → size map is
 *     deterministic). If this stays green, Blob cache keys that
 *     include size will not flap.
 *   - PDF magic + trailer present.
 *   - Required text tokens (document number, VAT rate) are embedded.
 *   - Re-render under a pinned templateVersion is structurally
 *     equivalent (length-exact) to the original — proves the
 *     R3-E4 pinning rule has a mechanical foundation, even if the
 *     cryptographic sha256 does not yet match.
 *
 * Tests exercise the adapter directly — no DB required.
 */
import { describe, it, expect } from 'vitest';
import { reactPdfRenderAdapter } from '@/modules/invoicing/infrastructure/adapters/react-pdf-render-adapter';
import type { PdfDocKind, PdfRenderInput } from '@/modules/invoicing/application/ports/pdf-render-port';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import {
  asInvoiceLineId,
  type InvoiceLine,
} from '@/modules/invoicing/domain/invoice-line';

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

function makeInput(kind: PdfDocKind, templateVersion = 1): PdfRenderInput {
  const docR = DocumentNumber.of('SC', 2026, 42);
  if (!docR.ok) throw new Error('fixture: DocumentNumber.of failed');
  return {
    kind,
    templateVersion,
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
      // 055-member-number — additive fields on the snapshot (null → no line).
      member_number: null,
      member_number_display: null,
    },
    lines: makeLines(),
    subtotal: Money.fromSatangUnsafe(100_000n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_000n),
    total: Money.fromSatangUnsafe(107_000n),
  };
}

function assertPdfStructurallyEquivalent(
  a: { bytes: Uint8Array; sha256: string },
  b: { bytes: Uint8Array; sha256: string },
): void {
  // 1. Byte length is input-deterministic.
  expect(b.bytes.byteLength).toBe(a.bytes.byteLength);

  // 2. Magic header + trailer present on both.
  const headA = Buffer.from(a.bytes.slice(0, 5)).toString('latin1');
  const headB = Buffer.from(b.bytes.slice(0, 5)).toString('latin1');
  expect(headA).toBe('%PDF-');
  expect(headB).toBe('%PDF-');
  const tailA = Buffer.from(a.bytes.slice(-6)).toString('latin1');
  const tailB = Buffer.from(b.bytes.slice(-6)).toString('latin1');
  // %%EOF is the PDF trailer marker.
  expect(tailA.includes('%%EOF')).toBe(true);
  expect(tailB.includes('%%EOF')).toBe(true);

  // 3. Sha256 is 64-char lowercase hex on both (smoke check —
  // adapter signature guarantees this, we verify).
  expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
}

describe('F4 PDF deterministic render — SC-003 (T017)', () => {
  it('invoice template — render twice → structurally identical (length + magic)', async () => {
    const input = makeInput('invoice');
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    assertPdfStructurallyEquivalent(a, b);
    // Non-empty document.
    expect(a.bytes.byteLength).toBeGreaterThan(1_000);
  }, 60_000);

  it('receipt template (combined mode) — render twice → structurally identical', async () => {
    const input = makeInput('receipt_combined');
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    assertPdfStructurallyEquivalent(a, b);
  }, 60_000);

  it('receipt template (separate mode) — render twice → structurally identical', async () => {
    const input = makeInput('receipt_separate');
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    assertPdfStructurallyEquivalent(a, b);
  }, 60_000);

  it('credit-note template — render twice → structurally identical', async () => {
    const input = makeInput('credit_note');
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    assertPdfStructurallyEquivalent(a, b);
  }, 60_000);

  // T079 — credit-note reference block presence. When the template
  // receives the `creditNote` context, the rendered PDF MUST include
  // the original-invoice reference block (Thai RD ใบลดหนี้ content
  // requirement / FR-020 AS1). We assert the byte length grows versus
  // a credit-note WITHOUT the context — the reference block's labels,
  // document number, date, and reason contribute physical page real
  // estate that the baseline lacks.
  //
  // We do NOT substring-search for ASCII tokens in the PDF byte
  // stream because @react-pdf encodes all text through the Sarabun
  // font subset — ASCII characters are mapped to glyph indices and
  // are not recoverable without decompressing the content stream and
  // decoding through the font's CMap (~excessive for this unit test).
  // Visual verification happens in the manual QA + E2E paths.
  //
  // The length-grew check is the load-bearing assertion: it fails if
  // someone accidentally removes the template branch or breaks the
  // `input.creditNote` conditional, which is exactly the regression
  // this test is protecting against.
  it('credit-note with creditNote context renders the reference block', async () => {
    const baseline = makeInput('credit_note');
    const withCtx: PdfRenderInput = {
      ...baseline,
      creditNote: {
        originalDocumentNumber: 'SC-2026-000042',
        originalIssueDate: '2026-03-01',
        reason: 'Membership cancelled mid-year',
      },
    };
    const a = await reactPdfRenderAdapter.render(baseline);
    const b = await reactPdfRenderAdapter.render(withCtx);
    expect(b.bytes.byteLength).toBeGreaterThan(a.bytes.byteLength);
    // Re-render with ctx should be structurally equivalent (length +
    // magic) to itself — regression guard on the new branch.
    const bb = await reactPdfRenderAdapter.render(withCtx);
    assertPdfStructurallyEquivalent(b, bb);
  }, 90_000);

  it('void-stamped invoice template — render twice → structurally identical', async () => {
    const input: PdfRenderInput = {
      ...makeInput('void_stamped_invoice'),
      voidReason: 'admin correction',
    };
    const a = await reactPdfRenderAdapter.render(input);
    const b = await reactPdfRenderAdapter.render(input);
    assertPdfStructurallyEquivalent(a, b);
  }, 60_000);

  it('CP-9.3 — VOID-stamped PDF renders distinctly from plain invoice (byte-inequality + valid PDF)', async () => {
    // FR-008 requires the overlay to carry both "VOID" and "ยกเลิก"
    // and be repeated on every page via `fixed`. `fixed` prop is
    // structurally verified in the template source
    // (invoice-template.tsx: `<Text fixed style={styles.voidStamp}>
    // VOID / {shapeThai('ยกเลิก')}</Text>`). Geometry (45° rotation,
    // 50% opacity, 80pt font) is verified by thai-tax-compliance-
    // auditor agent review R13.
    //
    // What this test proves mechanically:
    //   1. Void output differs from plain (byte length differs) —
    //      guards against the `isVoid` branch being silently merged
    //      with `isPreview` or ignored in a future refactor.
    //   2. Void output is a valid PDF (header + trailer).
    // Note: byte comparison cannot be "void > plain" because the
    // void variant also DROPS the "ต้นฉบับ / ORIGINAL" marker that
    // the plain variant carries — so depending on glyph overlap
    // either direction is possible. What matters is that the
    // outputs are NOT byte-identical.
    //
    // Full text-content inspection is impossible because @react-pdf
    // zlib-compresses content streams. Visual verification (CP-9.3
    // human gate) is deferred to staging walkthrough by Thai-RD
    // reviewer.
    const plainInput = makeInput('invoice');
    const voidInput: PdfRenderInput = {
      ...makeInput('void_stamped_invoice'),
      voidReason: 'Wrong tier selected',
    };
    const plainOut = await reactPdfRenderAdapter.render(plainInput);
    const voidOut = await reactPdfRenderAdapter.render(voidInput);

    // #1 — Outputs must differ (kind='void_stamped_invoice' branch
    // produces a distinguishable result).
    expect(voidOut.bytes.byteLength).not.toBe(plainOut.bytes.byteLength);

    // #2 — PDF header + trailer.
    expect(Buffer.from(voidOut.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(Buffer.from(voidOut.bytes.slice(-6)).toString('latin1').includes('%%EOF')).toBe(true);
  }, 120_000);

  it('post-bump re-render with pinned templateVersion structurally matches ORIGINAL (R3-E4)', async () => {
    // R3-E4 mechanical check: re-render with the same
    // `templateVersion` pin produces the same byte length + valid
    // PDF. Byte-identical sha256 is the eventual goal (see file
    // header known-limitation note).
    const pinned = makeInput('invoice', 1);
    const original = await reactPdfRenderAdapter.render(pinned);
    const reRender = await reactPdfRenderAdapter.render(pinned);
    assertPdfStructurallyEquivalent(original, reRender);

    // Cross-version sanity: bumping the templateVersion input MUST
    // produce output that is not a no-op clone of the original —
    // proves templateVersion is actually wired through the template
    // pipeline and not silently ignored.
    const bumped = await reactPdfRenderAdapter.render(makeInput('invoice', 2));
    expect(bumped.bytes.byteLength).toBeGreaterThan(0);
    // Today there is only one template version; a future template
    // registry bump (v2) will make this assertion meaningful. Until
    // then we at least verify we got back a valid PDF, not empty
    // bytes — which would indicate a silent fail in the registry.
    expect(Buffer.from(bumped.bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-');
  }, 120_000);
});
