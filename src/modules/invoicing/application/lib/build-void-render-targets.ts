/**
 * Bug 10 (money-remediation) — the VOID-overlay render construction, extracted
 * VERBATIM from `void-invoice.ts` Phase 1 so BOTH the use-case AND the
 * `void-pdf-reconcile` cron build the exact same tax-critical render inputs.
 *
 * This is a pure move: every field, comment, conditional spread, and titling
 * rule is preserved byte-for-byte from the original inline construction. The
 * WHT note (`invoiceSubject`), the §80/1(5) zero-rate spread (`...zeroRateSpread`),
 * the bill-vs-§86/4 titling (`billMode`/`voidUnderlyingKind`), and the
 * VAT-inclusive annotation (`vatInclusive`) are DOCUMENTED HIGH review fixes —
 * dropping any of them strips legally-required text from the re-rendered §86/4.
 * The extraction is guarded by adapter-level goldens (byte-length + extracted
 * text; NOT sha256 — @react-pdf v4 randomises the compressed font-subset stream,
 * so cross-render sha identity is unattainable, see void-kind-true-golden.test.ts).
 *
 * The ONLY changes vs the inline original:
 *   - `deps.pdfRender`/`deps.blob` → the `ports` argument;
 *   - `input.voidReason` → the `voidReason` argument (Phase 1 passes
 *     `input.voidReason`; the cron passes the persisted `loaded.voidReason` —
 *     equal, because `applyVoid` persisted it);
 *   - the two render `throw new VoidInvoiceInternalError({pdf_render_failed})`
 *     → `return err({ code: 'pdf_render_failed', reason })` so this stays a pure
 *     function; the Phase-1 caller re-throws to roll back (nothing is written
 *     before the render), and the cron maps it to a retry.
 *
 * Pure Application — no framework/ORM imports; the caller owns the tx + upload.
 */
import { err, ok, type Result } from '@/lib/result';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { Invoice } from '@/modules/invoicing/domain/invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { loadTenantLogo } from './load-tenant-logo';
import { sanitiseErrorReason } from './sanitise-error-reason';

/**
 * 088 T068 — a void re-render TARGET: one Blob to overwrite. A voided ISSUED
 * bill / legacy §86/4 / §105 has ONE target (the main `pdf`); a voided PAID
 * membership has TWO (the ใบแจ้งหนี้ `pdf` bill + the separate §86/4 `receiptPdf`).
 * `persist` selects the sha column to sync in Phase 2; `syncContext`
 * discriminates the two blobs' Phase-2 failure audit rows.
 */
export type VoidRenderTarget = {
  readonly blobKey: string;
  readonly rendered: { readonly bytes: Uint8Array; readonly sha256: Sha256Hex };
  readonly persist: 'invoice' | 'receipt';
  readonly syncContext:
    | 'invoice_void_phase2_sync'
    | 'invoice_void_phase2_receipt_sync';
};

export type BuildVoidRenderTargetsError =
  | { readonly code: 'no_snapshot_on_invoice' }
  | { readonly code: 'pdf_render_failed'; readonly reason: string };

export interface BuildVoidRenderTargetsResult {
  readonly mainDocNum: DocumentNumber;
  readonly targetA: VoidRenderTarget;
  readonly targetB: VoidRenderTarget | null;
  readonly originalReceiptPdfSha: Sha256Hex | null;
}

export async function buildVoidRenderTargets(
  ports: { readonly pdfRender: PdfRenderPort; readonly blob: BlobStoragePort },
  loaded: Invoice,
  voidReason: string,
): Promise<Result<BuildVoidRenderTargetsResult, BuildVoidRenderTargetsError>> {
  // Render-input completeness narrowing (mirror of void-invoice.ts Phase 1) —
  // re-run here so the cron, which loads the row independently, gets the same
  // guard and TS narrows every nullable render input below.
  if (
    !loaded.memberIdentitySnapshot ||
    !loaded.tenantIdentitySnapshot ||
    !loaded.subtotal ||
    !loaded.vat ||
    !loaded.total ||
    !loaded.vatRate ||
    !loaded.fiscalYear ||
    !loaded.issueDate ||
    !loaded.pdf
  ) {
    return err({ code: 'no_snapshot_on_invoice' });
  }

  // 059 / PR-A Task 6b — the retained §87/3 evidence copy must reproduce the
  // 088 T068 — resolve the number the MAIN blob prints under. It is
  // whatever number the main document was ORIGINALLY issued with:
  //   - `documentNumber`         → legacy §87 §86/4 invoice / as-paid TIN combined
  //   - `billDocumentNumberRaw`  → new-flow ใบแจ้งหนี้ bill (SC)
  //   - `receiptDocumentNumberRaw` → β no-TIN as-paid §105 (main pdf IS the receipt)
  // Ordered bill-BEFORE-receipt so a paid new-flow membership (which carries
  // BOTH raw numbers) resolves the main bill to its SC number, not the RC.
  let mainDocNum: DocumentNumber;
  if (loaded.documentNumber !== null) {
    mainDocNum = loaded.documentNumber;
  } else if (loaded.billDocumentNumberRaw !== null) {
    const parsed = DocumentNumber.parse(loaded.billDocumentNumberRaw);
    if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
    mainDocNum = parsed.value;
  } else if (loaded.receiptDocumentNumberRaw !== null) {
    const parsed = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
    if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
    mainDocNum = parsed.value;
  } else {
    return err({ code: 'no_snapshot_on_invoice' });
  }
  // The main blob is a NON-tax ใบแจ้งหนี้ bill iff it was ISSUED as a bill:
  // pdf_doc_kind 'invoice' AND a bill number was allocated. A legacy §86/4
  // invoice also has pdf_doc_kind 'invoice' but NO bill number → billMode
  // stays absent → the void re-render keeps the ใบกำกับภาษี title (SC-003).
  const mainIsBill =
    loaded.pdfDocKind === 'invoice' && loaded.billDocumentNumberRaw !== null;

  // Zero-rate note inputs — threaded ONLY on a §80/1(5) row so a standard
  // re-render is byte-identical (undefined omitted from the deterministic
  // seed, SC-003). Mirrors record-payment / issue-credit-note.
  const zeroRateSpread =
    loaded.vatTreatment === 'zero_rated_80_1_5'
      ? {
          vatTreatment: loaded.vatTreatment,
          zeroRateCertNo: loaded.zeroRateCertNo,
          zeroRateCertDate: loaded.zeroRateCertDate,
        }
      : {};

  // D. Re-render the MAIN blob (Target A) with the VOID overlay, using its
  // PINNED template version per FR-016 / R3-E4 (v1 invoices re-render
  // byte-identical — logo suppressed for v1).
  const tenantLogoA = await loadTenantLogo(
    ports.blob,
    loaded.tenantIdentitySnapshot.logo_blob_key,
    loaded.pdf.templateVersion,
  );
  let renderedA;
  try {
    renderedA = await ports.pdfRender.render({
      kind: 'void_stamped_invoice',
      // 064 W1 S31 — kind-true void title: the template titles the VOID
      // document by what the ORIGINAL was (persisted at issue, migration
      // 0211), keeping the VOID watermark. A legacy §105 ใบเสร็จรับเงิน
      // original must not come back titled ใบกำกับภาษี. `?? 'invoice'`
      // is defensive only — `invoices_non_draft_has_doc_kind` makes a
      // null pdfDocKind unrepresentable on an issued row.
      voidUnderlyingKind: loaded.pdfDocKind ?? 'invoice',
      templateVersion: loaded.pdf.templateVersion,
      documentNumber: mainDocNum,
      issueDate: loaded.issueDate,
      dueDate: loaded.dueDate,
      tenant: loaded.tenantIdentitySnapshot,
      tenantLogo: tenantLogoA,
      member: loaded.memberIdentitySnapshot,
      lines: loaded.lines,
      subtotal: loaded.subtotal,
      vatRate: loaded.vatRate,
      vat: loaded.vat,
      total: loaded.total,
      voidReason: voidReason,
      // 088 US5 (T041 / FR-012 / SC-007) — a voided membership document is
      // the retained §87/3 evidence copy of what was cancelled: keep the WHT
      // note it originally carried (gated v>=7, so pre-v7 voids are byte-stable).
      invoiceSubject: loaded.invoiceSubject,
      // 088 T068 H-1 — preserve the VAT-inclusive annotation (event Model B)
      // on the VOID evidence copy. A one-blob EVENT as-paid receipt (§105
      // receipt_separate + as-paid-TIN receipt_combined) is stamped HERE by
      // Target A and carries vatInclusive=true (issue-event-invoice-as-paid);
      // dropping it would misstate a VAT-inclusive §87/3 retained copy as
      // VAT-exclusive (SC-003 infidelity). Mirrors Target B + record-payment
      // + issue-credit-note. Membership is vatInclusive=false (no annotation).
      vatInclusive: loaded.vatInclusive,
      // 088 T068 — a voided new-flow ใบแจ้งหนี้ bill keeps its non-tax bill
      // title (never re-titled "Tax Invoice"). `billMode` disambiguates it
      // from a legacy §86/4 void (which shares voidUnderlyingKind='invoice');
      // spread ONLY for a bill so every legacy/§86/4 void is byte-identical.
      ...(mainIsBill ? { billMode: true } : {}),
      ...zeroRateSpread,
    });
  } catch (e) {
    return err({ code: 'pdf_render_failed', reason: sanitiseErrorReason(e) });
  }
  const targetA: VoidRenderTarget = {
    blobKey: loaded.pdf.blobKey,
    rendered: renderedA,
    persist: 'invoice',
    syncContext: 'invoice_void_phase2_sync',
  };

  // D2. 088 § F.3 / CHK027 — a PAID membership carries a DISTINCT §86/4 tax
  // receipt blob (`receiptPdf`, the record-payment separate-receipt path).
  // Stamp it too so a voided sale never leaves an un-stamped downloadable
  // tax receipt. A one-blob paid row (as-paid combined, legacy combined,
  // event-no-TIN §105) has `receiptPdf === null` → Target B is skipped and
  // its single blob is stamped by Target A above. Mirrors issue-credit-note
  // § J2 (receipt number = RC; date = payment date on the new flow, issue
  // date on legacy reuse; the separate receipt is always the combined
  // §86/4+§105ทวิ document → voidUnderlyingKind='receipt_combined').
  let targetB: VoidRenderTarget | null = null;
  const originalReceiptPdfSha = loaded.receiptPdf?.sha256 ?? null;
  if (loaded.receiptPdf !== null) {
    let receiptDocNum: DocumentNumber;
    if (loaded.receiptDocumentNumberRaw !== null) {
      const parsed = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
      if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
      receiptDocNum = parsed.value;
    } else if (loaded.documentNumber !== null) {
      receiptDocNum = loaded.documentNumber;
    } else {
      return err({ code: 'no_snapshot_on_invoice' });
    }
    const receiptIssueDate =
      loaded.documentNumber === null ? loaded.paymentDate : loaded.issueDate;
    if (receiptIssueDate === null) {
      return err({ code: 'no_snapshot_on_invoice' });
    }
    const tenantLogoB = await loadTenantLogo(
      ports.blob,
      loaded.tenantIdentitySnapshot.logo_blob_key,
      loaded.receiptPdf.templateVersion,
    );
    let renderedB;
    try {
      renderedB = await ports.pdfRender.render({
        kind: 'void_stamped_invoice',
        // 088 T068 N-1 — Target B ASSUMES the separate `receiptPdf` blob is
        // always the combined §86/4+§105ทวิ receipt. That holds because the
        // ONLY path that writes a distinct receipt blob is record-payment
        // (membership + bill-first TIN event) → `receipt_combined`; the
        // event-no-TIN §105 `receipt_separate` path never reaches
        // record-payment (rejected at record-payment.ts as non-payable) and
        // its §105 doc is the SINGLE main `pdf` (stamped by Target A, not
        // here). If that guard is ever removed, a §105 separate receipt
        // would land here and be MIS-TITLED as ใบกำกับภาษี/ใบเสร็จรับเงิน —
        // gate this branch on the persisted receipt kind instead.
        voidUnderlyingKind: 'receipt_combined',
        templateVersion: loaded.receiptPdf.templateVersion,
        documentNumber: receiptDocNum,
        issueDate: receiptIssueDate,
        dueDate: loaded.dueDate,
        tenant: loaded.tenantIdentitySnapshot,
        tenantLogo: tenantLogoB,
        member: loaded.memberIdentitySnapshot,
        lines: loaded.lines,
        subtotal: loaded.subtotal,
        vatRate: loaded.vatRate,
        vat: loaded.vat,
        total: loaded.total,
        voidReason: voidReason,
        invoiceSubject: loaded.invoiceSubject,
        // Mirror issue-credit-note § J2 receipt re-render: preserve the
        // VAT-inclusive annotation (event Model B) on the cancelled receipt.
        vatInclusive: loaded.vatInclusive,
        ...zeroRateSpread,
      });
    } catch (e) {
      return err({ code: 'pdf_render_failed', reason: sanitiseErrorReason(e) });
    }
    targetB = {
      blobKey: loaded.receiptPdf.blobKey,
      rendered: renderedB,
      persist: 'receipt',
      syncContext: 'invoice_void_phase2_receipt_sync',
    };
  }

  return ok({ mainDocNum, targetA, targetB, originalReceiptPdfSha });
}
