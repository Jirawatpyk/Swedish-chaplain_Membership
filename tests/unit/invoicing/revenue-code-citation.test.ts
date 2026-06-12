/**
 * Task 31 (065-review-followups) — tax-auditor finding M-D: the PDF
 * footer printed "เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4" UNCONDITIONALLY
 * on every document kind. A §105 ใบเสร็จรับเงิน is not a §86/4 tax
 * invoice; a ใบลดหนี้ is governed by §86/10; the combined as-paid
 * document is §86/4 + §105ทวิ.
 *
 * This unit suite pins the PURE citation-selection helper:
 *
 *   invoice / invoice_preview → มาตรา 86/4
 *   receipt_combined          → มาตรา 86/4 และ 105ทวิ
 *   receipt_separate          → มาตรา 105 (and NOT labelled เอกสารภาษี —
 *                               a §105 receipt is not a VAT tax document)
 *   credit_note               → มาตรา 86/10
 *   void_stamped_invoice      → cite per voidUnderlyingKind ?? 'invoice'
 *                               (the 064 W1 S31 kind-true mechanism)
 *
 * The TEMPLATE-VERSION gate (kind-aware only at >= v3; older pinned
 * versions keep the legacy unconditional string byte-for-byte per
 * SC-003) is pinned at the byte level in
 * tests/integration/invoicing/footer-citation-golden.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  KIND_AWARE_CITATION_MIN_VERSION,
  LEGACY_FOOTER_CITATION,
  revenueCodeCitation,
} from '@/modules/invoicing/infrastructure/pdf/templates/revenue-code-citation';
import { CURRENT_TEMPLATE_VERSION } from '@/modules/invoicing/infrastructure/pdf/template-registry';

const TH_86_4 = 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4';
const TH_COMBINED = 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4 และ 105ทวิ';
const TH_105 = 'เอกสารตามประมวลรัษฎากร มาตรา 105';
const TH_86_10 = 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/10';

describe('revenueCodeCitation — kind-aware §-citation (M-D)', () => {
  it("invoice → §86/4 (ใบกำกับภาษี is the §86/4 tax invoice)", () => {
    expect(revenueCodeCitation('invoice')).toBe(TH_86_4);
  });

  it('invoice_preview → §86/4 (previews the §86/4 document; PREVIEW watermark carries the non-document marker)', () => {
    expect(revenueCodeCitation('invoice_preview')).toBe(TH_86_4);
  });

  it('receipt_combined → §86/4 และ 105ทวิ (the as-paid combined document is BOTH)', () => {
    expect(revenueCodeCitation('receipt_combined')).toBe(TH_COMBINED);
  });

  it('receipt_separate → §105 only — and NOT prefixed เอกสารภาษี (a §105 receipt is not a VAT tax document)', () => {
    const citation = revenueCodeCitation('receipt_separate');
    expect(citation).toBe(TH_105);
    expect(citation).not.toContain('86/4');
    expect(citation).not.toContain('ทวิ');
    expect(citation).not.toContain('เอกสารภาษี');
  });

  it('credit_note → §86/10 (ใบลดหนี้), never §86/4', () => {
    const citation = revenueCodeCitation('credit_note');
    expect(citation).toBe(TH_86_10);
    expect(citation).not.toContain('86/4');
  });

  describe('void_stamped_invoice — cites per voidUnderlyingKind (064 kind-true mechanism)', () => {
    it("underlying 'invoice' → §86/4", () => {
      expect(revenueCodeCitation('void_stamped_invoice', 'invoice')).toBe(TH_86_4);
    });

    it("underlying 'receipt_combined' → §86/4 และ 105ทวิ", () => {
      expect(revenueCodeCitation('void_stamped_invoice', 'receipt_combined')).toBe(
        TH_COMBINED,
      );
    });

    it("underlying 'receipt_separate' → §105 (the retained §87/3 evidence copy keeps its legal identity)", () => {
      expect(revenueCodeCitation('void_stamped_invoice', 'receipt_separate')).toBe(TH_105);
    });

    it('ABSENT underlying kind → falls back to §86/4 (mirrors voidInvoice pdfDocKind ?? "invoice")', () => {
      expect(revenueCodeCitation('void_stamped_invoice')).toBe(TH_86_4);
      expect(revenueCodeCitation('void_stamped_invoice', undefined)).toBe(TH_86_4);
    });
  });

  it('non-void kinds IGNORE voidUnderlyingKind (port contract: only read when kind === void_stamped_invoice)', () => {
    expect(revenueCodeCitation('credit_note', 'receipt_separate')).toBe(TH_86_10);
    expect(revenueCodeCitation('invoice', 'receipt_separate')).toBe(TH_86_4);
    expect(revenueCodeCitation('receipt_separate', 'invoice')).toBe(TH_105);
  });

  describe('version-gate constants', () => {
    it('LEGACY_FOOTER_CITATION is byte-for-byte the pre-v3 unconditional string (SC-003 anchor)', () => {
      expect(LEGACY_FOOTER_CITATION).toBe(TH_86_4);
    });

    it('the invoice citation REUSES the legacy string (same document class — must never drift apart)', () => {
      expect(revenueCodeCitation('invoice')).toBe(LEGACY_FOOTER_CITATION);
    });

    it('kind-aware citations activate at v3', () => {
      expect(KIND_AWARE_CITATION_MIN_VERSION).toBe(3);
    });

    it('CURRENT_TEMPLATE_VERSION >= the kind-aware gate — new issuance always gets kind-true citations', () => {
      expect(CURRENT_TEMPLATE_VERSION).toBeGreaterThanOrEqual(
        KIND_AWARE_CITATION_MIN_VERSION,
      );
    });
  });
});
