/**
 * T032 — PDF render port (F4).
 *
 * Adapter wraps `@react-pdf/renderer` + Sarabun font registration.
 * Rendering MUST be deterministic (SC-003 byte-identical re-render).
 */

import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { Money } from '@/modules/invoicing/domain/value-objects/money';
import type { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import type { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { TenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

export type PdfDocKind =
  | 'invoice'
  | 'invoice_preview'
  | 'receipt_combined'
  | 'receipt_separate'
  | 'credit_note'
  | 'void_stamped_invoice';

export interface PdfRenderInput {
  readonly kind: PdfDocKind;
  readonly templateVersion: number;
  readonly documentNumber: DocumentNumber | null; // null for preview
  readonly issueDate: string | null;               // null for preview
  readonly dueDate: string | null;
  readonly tenant: TenantIdentitySnapshot;
  readonly member: MemberIdentitySnapshot;
  /**
   * 059 / PR-A Task 6b — the RESOLVED buyer VAT-registrant status for THIS
   * render, i.e. exactly what `resolveBuyerIsVatRegistrant(memberId, snapshot)`
   * returned when the caller made its document-CLASS decision (issue-time kind,
   * receipt kind, etc.). Deliberately top-level — NOT a field on `member` — so it
   * can never be mistaken for part of the frozen snapshot.
   *
   * WHY THIS EXISTS: `member.buyer_is_vat_registrant` (the snapshot field) is the
   * RECORDED fact for a matched member, but is ALWAYS `false` for a walk-in
   * (non-member) buyer — `create-event-invoice-draft.ts` never writes it there,
   * because a 13-digit number is not proof of registration and must not be
   * asserted onto the snapshot on a guess (see document-kind.ts). The walk-in's
   * registrant status is instead INFERRED from TIN-presence by
   * `resolveBuyerIsVatRegistrant`, and that inference is exactly what decided
   * this document's CLASS (e.g. `kind: 'invoice'` instead of `receipt_separate`).
   * Before this field existed, the template read `member.buyer_is_vat_registrant`
   * directly for the Tax ID line (`buyerTaxIdEl`) — always `false` for a walk-in
   * — so a walk-in whose own TIN classed the document as a tax invoice had that
   * same TIN silently dropped from the line it exists to support. Every caller
   * MUST pass the SAME value it fed into its `inferEventDocumentKind` /
   * `inferReceiptKind` call, via the ONE shared resolver — never re-derive.
   *
   * REQUIRED (not optional) on purpose: this makes a missed call site a TS
   * compile error instead of a silent `undefined` that only breaks at print
   * time on live-Neon data.
   *
   * `buyerBranchEl` (the §86/4 สำนักงานใหญ่/สาขา line) does NOT read this field —
   * it stays keyed on `member.buyer_is_vat_registrant` (the RECORDED fact) only.
   * See the comment on `buyerBranchEl` in invoice-template.tsx for why the two
   * must never be unified.
   */
  readonly buyerIsVatRegistrant: boolean;
  readonly lines: readonly InvoiceLine[];
  readonly subtotal: Money;
  readonly vatRate: VatRate;
  readonly vat: Money;
  readonly total: Money;
  /**
   * 054-event-fee-invoices — whether the document's amounts are VAT-INCLUSIVE
   * (event Model B): the line totals carry the all-in (gross) ticket price and
   * `subtotal`/`vat` are the back-calculated split. When true, the template
   * renders a "ราคารวมภาษีมูลค่าเพิ่มแล้ว / VAT included" annotation near the
   * totals so a Thai reader understands the line amount is gross while the
   * subtotal is net. Membership invoices are VAT-EXCLUSIVE (`false`/omitted):
   * the line amounts are net and VAT is added on top. Optional so existing
   * callers (credit-note, void, preview, receipt re-render) default to
   * exclusive without change.
   */
  readonly vatInclusive?: boolean;
  /**
   * 088-invoice-tax-flow-redesign (US1 / T016) — render the `'invoice'` /
   * `'invoice_preview'` kind as the NON-tax ใบแจ้งหนี้ / Invoice (no §86/4
   * title, no ต้นฉบับ/ORIGINAL marker, no §-citation footer) instead of the
   * legacy §86/4 ใบกำกับภาษี / Tax Invoice. Set to `true` by `issueInvoice`
   * ONLY when `FEATURE_088_TAX_AT_PAYMENT` is on (the bill is then a non-§87
   * `SC` document). OPTIONAL + defaults to the legacy titles when absent, so
   * every pre-088 render input is byte-identical and the receipt / credit-note
   * / void kinds are unaffected (only the pre-payment bill kind relabels).
   */
  readonly billMode?: boolean;
  /**
   * 088-invoice-tax-flow-redesign (US5 / T041 / FR-012 / SC-007) — the subject of
   * the underlying invoice. Gates the tenant WHT footer note, which renders on
   * `'membership'` documents ONLY (both the ใบแจ้งหนี้ bill AND the §86/4 tax
   * receipt), NEVER on `'event'` documents. Threaded from `draft.invoiceSubject`
   * (issuance / preview) or the stored `invoice.invoiceSubject` (receipt / void
   * re-render) so every render path of a given document gates consistently.
   *
   * OPTIONAL / undefined-guarded: a render input that omits it (credit-note, or
   * any pre-088 caller) → the WHT-note gate is `=== 'membership'` → false → no
   * note. `undefined` is omitted by `JSON.stringify`, so the deterministic render
   * seed is unchanged for callers that do not set it (SC-003 byte-stable).
   */
  readonly invoiceSubject?: 'membership' | 'event';
  /**
   * 088-invoice-tax-flow-redesign (US8 / T058 / FR-025 / SC-008) — the pinned
   * per-invoice VAT treatment. When `'zero_rated_80_1_5'` AND `templateVersion
   * >= ZERO_RATE_NOTE_MIN_VERSION` (=8), the §86/4 tax receipt renders the
   * §80/1(5) note ("VAT 0% under §80/1(5); MFA certificate no. … / date …")
   * from `zeroRateCertNo` + `zeroRateCertDate`. The scan is NOT appended — the
   * cert is referenced by number/date only (G6).
   *
   * OPTIONAL + undefined-guarded: threaded ONLY on a zero-rated document, so a
   * `'standard'` invoice (and every pre-088 caller) omits it → the deterministic
   * render seed is unchanged and the note never renders (SC-003 byte-stable).
   * VAT 0% / 0.00 itself is driven by `subtotal`/`vat`/`vatRate` (already
   * present) — the note is the only new element. Membership is always
   * `'standard'`, so the note never draws on a membership document.
   */
  readonly vatTreatment?: 'standard' | 'zero_rated_80_1_5';
  readonly zeroRateCertNo?: string | null;
  readonly zeroRateCertDate?: string | null;
  readonly voidReason?: string | null;
  /**
   * 064 W1 S31 — what the document being VOID-stamped ORIGINALLY was.
   * Only read when `kind === 'void_stamped_invoice'`; ignored otherwise.
   * The void variant picks its TITLE from this kind (keeping the VOID
   * watermark) so a §105 ใบเสร็จรับเงิน original is never re-rendered
   * under a ใบกำกับภาษี title — the retained §87/3 evidence copy must
   * keep the legal identity of the document it cancels.
   *
   * OPTIONAL + ADDITIVE on purpose (no template-version bump): when
   * absent the render input is JSON-identical to every pre-change void
   * render input (same deterministic seed) and the template falls
   * through to the historical default title (ใบกำกับภาษี / Tax
   * Invoice), so old renders are unaffected. `voidInvoice` passes the
   * row's persisted `pdfDocKind ?? 'invoice'`.
   */
  readonly voidUnderlyingKind?: 'invoice' | 'receipt_combined' | 'receipt_separate';
  /**
   * T078/T079 — credit-note-specific context. Required when
   * `kind === 'credit_note'`; ignored otherwise. Carries the reference
   * to the original invoice so the template can render the required
   * "in reference to invoice #… dated …" block (Thai RD ใบลดหนี้
   * content requirement).
   */
  readonly creditNote?: {
    readonly originalDocumentNumber: string;
    readonly originalIssueDate: string;
    readonly reason: string;
  } | null;
  /**
   * US6 AS4 — credited-invoice annotation. Rendered on INVOICE kind
   * when the parent row has transitioned to `partially_credited` or
   * `credited`. Adds a diagonal "CREDITED / ลดหนี้แล้ว" (or
   * "PARTIALLY CREDITED / ลดหนี้บางส่วน") overlay + a footer table
   * listing the referencing credit-note numbers + dates + totals.
   * Non-destructive: does NOT remove or obscure the original invoice
   * content (Thai RD legal continuity).
   */
  readonly creditedAnnotation?: {
    readonly fullyCredited: boolean;
    readonly references: ReadonlyArray<{
      readonly documentNumber: string;
      readonly issueDate: string;
      readonly total: Money;
    }>;
  } | null;
  /**
   * Tenant logo bytes — render-time-only (NOT persisted on the
   * invoice snapshot). When set, the template renders the logo above
   * the tenant identity block. Loaded from Blob by `loadTenantLogo`
   * using the `logo_blob_key` from the tenant identity snapshot.
   *
   * Determinism: bytes are stable (immutable Blob object) → same input
   * → same seed → byte-identical re-render. The deterministic-render
   * replacer hashes Uint8Array values to keep the seed-input compact.
   */
  readonly tenantLogo?: {
    readonly bytes: Uint8Array;
    readonly format: 'png' | 'jpg';
  } | null;
}

export interface PdfRenderResult {
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Hex;
}

export interface PdfRenderPort {
  render(input: PdfRenderInput): Promise<PdfRenderResult>;
}
