/**
 * Task 31 (065-review-followups) — kind-aware Revenue-Code §-citation
 * for the PDF footer (tax-auditor finding M-D, template v3).
 *
 * The footer previously printed "เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4"
 * UNCONDITIONALLY on every document kind — legally wrong on three of
 * them: a §105 ใบเสร็จรับเงิน is NOT a §86/4 tax invoice (the exact
 * mislabel class the 064 §105 redesign exists to prevent), a ใบลดหนี้
 * is governed by §86/10, and the as-paid combined document is
 * §86/4 + §105ทวิ.
 *
 * Citation map (ruling: docs/superpowers/specs/
 * 2026-06-10-event-invoice-paid-flow-design.md §2/§3):
 *
 *   invoice / invoice_preview → มาตรา 86/4        (ใบกำกับภาษี)
 *   receipt_combined          → มาตรา 86/4 และ 105ทวิ
 *   receipt_separate          → มาตรา 105          (ใบเสร็จรับเงิน —
 *                               prefixed เอกสารตามประมวลรัษฎากร, NOT
 *                               เอกสารภาษี: a §105 receipt is not a VAT
 *                               tax document. Wording flagged for the
 *                               tax re-review.)
 *   credit_note               → มาตรา 86/10        (ใบลดหนี้)
 *   void_stamped_invoice      → cite per voidUnderlyingKind ?? 'invoice'
 *                               (the 064 W1 S31 kind-true mechanism —
 *                               the retained §87/3 evidence copy keeps
 *                               the legal identity of what it cancels)
 *
 * VERSION GATE — a hot-fix without a template-version bump is
 * FORBIDDEN here: already-issued rows re-render under their PINNED
 * `pdf_template_version` (void overlay, J2 credited annotation, async
 * receipt worker — R3-E4), so changing the footer for old versions
 * would break the SC-003 reproduce-the-original guarantee. The
 * template applies the kind-aware citation ONLY when
 * `templateVersion >= KIND_AWARE_CITATION_MIN_VERSION`; v1/v2 keep
 * `LEGACY_FOOTER_CITATION` byte-for-byte. Measured pre/post evidence:
 * docs/Bug/065-t31-footer-{pre,post}change.txt.
 */
import type { PdfDocKind } from '../../../application/ports/pdf-render-port';

/**
 * The pre-v3 unconditional footer citation. MUST stay byte-for-byte
 * what the template printed on every v1/v2 document — pinned-version
 * re-renders depend on it (SC-003).
 */
export const LEGACY_FOOTER_CITATION = 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4';

/**
 * First template version whose footer citation is kind-aware. Renders
 * pinned below this version keep `LEGACY_FOOTER_CITATION`
 * unconditionally. Registry log: template-registry.ts v3 entry.
 */
export const KIND_AWARE_CITATION_MIN_VERSION = 3 as const;

/** What a VOID-stamped re-render originally was (mirrors the port field). */
export type VoidUnderlyingKind = 'invoice' | 'receipt_combined' | 'receipt_separate';

/**
 * Pure citation selection. `voidUnderlyingKind` is only read when
 * `kind === 'void_stamped_invoice'` (port contract) — for a void
 * overlay the citation follows the document being cancelled, falling
 * back to 'invoice' when absent (all pre-064 void rows), exactly like
 * the kind-true TITLE mechanism.
 */
export function revenueCodeCitation(
  kind: PdfDocKind,
  voidUnderlyingKind?: VoidUnderlyingKind,
): string {
  const effective: Exclude<PdfDocKind, 'void_stamped_invoice'> =
    kind === 'void_stamped_invoice' ? (voidUnderlyingKind ?? 'invoice') : kind;
  switch (effective) {
    case 'invoice':
    case 'invoice_preview':
      // Same document class as the legacy unconditional string — reuse
      // it so the two can never drift apart.
      return LEGACY_FOOTER_CITATION;
    case 'receipt_combined':
      return 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/4 และ 105ทวิ';
    case 'receipt_separate':
      return 'เอกสารตามประมวลรัษฎากร มาตรา 105';
    case 'credit_note':
      return 'เอกสารภาษีตามประมวลรัษฎากร มาตรา 86/10';
  }
}
