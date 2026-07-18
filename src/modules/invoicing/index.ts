/**
 * Public barrel for the `invoicing` bounded context (F4).
 *
 * The ONLY surface that code OUTSIDE `src/modules/invoicing/**` may
 * import from. ESLint barrel-guard rule blocks deep imports into
 * ./domain/**, ./application/**, ./infrastructure/**.
 */

// --- Domain branded types ---------------------------------------------------
export {
  INVOICE_STATUSES,
  MAX_EVENT_INVOICE_SATANG,
  asInvoiceId,
  parseInvoiceId,
  isTerminal,
  invoiceStatusHasReceipt,
  canTransition,
  enforceOneSubjectLine,
  displayDocumentNumber,
  issuedInvoiceIdentity,
  billFirstDocumentNumber,
  resolveTaxDocumentKind,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
  type InvoiceIdError,
  type InvoiceTransitionError,
} from './domain/invoice';
export {
  INVOICE_LINE_KINDS,
  asInvoiceLineId,
  type InvoiceLine,
  type InvoiceLineKind,
  type InvoiceLineId,
} from './domain/invoice-line';
export {
  PRO_RATE_POLICIES,
  type ProRatePolicy,
} from './domain/value-objects/pro-rate-policy';
export { Money } from './domain/value-objects/money';
// F5 bridge alias: `AmountSatang` is the same class as `Money`, re-
// exported under a satang-centric name so F5 code (which deals with
// processor satang amounts directly and never needs THB display
// formatting) reads idiomatically. Both names resolve to the same
// constructor — `AmountSatang === Money` is an invariant guarded by
// `tests/unit/invoicing/barrel-exports.test.ts`.
export { Money as AmountSatang } from './domain/value-objects/money';
export { VatRate } from './domain/value-objects/vat-rate';
export { calculateVat } from './domain/policies/calculate-vat';
// 088 US8 (§ F.8) — per-invoice VAT-treatment policy (drives the rate + the
// ≥5,000-THB advisory-warn threshold). Public so the serialiser/route surfaces
// can compute the FR-024 non-blocking warning without a deep domain import.
export {
  resolveVatRate,
  isZeroRateBelowThreshold,
  ZERO_RATE_MIN_SUBTOTAL_SATANG,
  type VatTreatment,
} from './domain/policies/vat-treatment';
export { splitVatInclusive } from './domain/value-objects/vat-inclusive';
// 088 (T2 type-design finding) — the explicit 2-state FLOW flag for
// tax-at-payment, replacing the tri-read `boolean | undefined`. The orthogonal
// reconciliation axis is a separate `reconciliationPath: boolean` on the
// stranded-funds read (not this flag). Payments imports the TYPE from here
// (cross-context public interface); the `taxAtPaymentFlag` mapper is used by
// both modules' composition roots.
export {
  taxAtPaymentFlag,
  type TaxAtPaymentFlag,
} from './domain/tax-at-payment-flag';
// FIX 5 — shared §86/4 buyer-TIN / event-document-kind discriminator (dedup of
// the inline check formerly repeated across issue-invoice / record-payment /
// issue-credit-note).
export {
  buyerHasTin,
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
  type InvoiceSubject,
  type EventDocumentKind,
  type BuyerRegistrantParts,
} from './domain/document-kind';
export {
  DocumentNumber,
  DOCUMENT_NUMBER_MAX_SEQ,
} from './domain/value-objects/document-number';
export {
  asFiscalYear,
  type FiscalYear,
} from './domain/value-objects/fiscal-year';
export type { TenantIdentitySnapshot } from './domain/value-objects/tenant-identity-snapshot';
export {
  MalformedSnapshotError,
  memberIdentitySnapshotSchema,
  type MemberIdentitySnapshot,
} from './domain/value-objects/member-identity-snapshot';
export { Sha256Hex } from './domain/value-objects/sha256-hex';
// `Sha256HexError` intentionally not exported — consumers receive the
// inline `{ ok:false, error:{kind,raw} }` shape from `Sha256Hex.parse`
// and rarely need the nominal type.

// --- Audit event types (for F3 timeline integration US7) --------------------
export type { F4AuditEventType, F4AuditEvent } from './application/ports/audit-port';

// --- Cross-module callback events --------------------------------------------
// `F4InvoicePaidEvent` is the canonical payload shape passed to listeners
// registered on `RecordPaymentDeps.onPaidCallbacks` — fired atomically inside
// the same DB transaction that flips the invoice `issued → paid`. Field
// rationale + atomic semantics are documented at the type definition.
export type {
  F4InvoicePaidEvent,
  F4InvoicePaidPaymentMethod,
  F4InvoicePaidTrigger,
} from './domain/f4-invoice-paid-event';

/**
 * US7 — F4 audit event types surfaced in the F3 member timeline.
 * All events here carry `member_id` in their payload so the F3
 * timeline repo (which filters by `payload->>'member_id'`) picks them
 * up without any JOIN. This is the contract between F4 emit sites +
 * the copy resolver.
 *
 * Runtime-only vs. compile-time contract:
 *   This list is WIDER than `F4MemberTimelineAuditEventType` in
 *   `ports/audit-port.ts`. The audit-port union only declares types
 *   that ALREADY have an emit site, so the compile-time `member_id`
 *   guarantee isn't hollow. The runtime array below additionally
 *   carries types whose emit is deferred but whose copy mapping is
 *   ready — the resolver + timeline pick them up automatically when
 *   the emit lands.
 *
 * Deferred emit sites:
 *   - `invoice_voided`       — US5 / Phase 9 T105.
 *   - `invoice_pdf_resent`   — Phase 10 T107.
 *
 * Deliberately excluded (operational duplicates):
 *   - `receipt_pdf_resent` + `credit_note_pdf_resent` — dup the
 *     underlying pay/credit event and would double-render.
 */
export const F4_MEMBER_TIMELINE_EVENT_TYPES = [
  'invoice_draft_created',
  'invoice_issued',
  'invoice_paid',
  'invoice_voided',
  'credit_note_issued',
  'invoice_pdf_resent',
  // 088-invoice-tax-flow-redesign (T019a / FR-029) — the §86/4 tax-receipt
  // minted at payment. Emitted in-tx by record-payment / issue-event-invoice-
  // as-paid with `member_id` (membership) or `event_registration_id` (event)
  // + `receipt_document_number_raw` (the §87 `RC` number). Surfaces on the F3
  // member timeline alongside `invoice_paid` so the payment moment is not
  // doubled; the copy resolver interpolates the `RC-…` number + links the doc.
  'tax_receipt_issued',
] as const;

export type F4MemberTimelineEventType =
  (typeof F4_MEMBER_TIMELINE_EVENT_TYPES)[number];

export function isF4MemberTimelineEventType(
  v: string,
): v is F4MemberTimelineEventType {
  return (F4_MEMBER_TIMELINE_EVENT_TYPES as readonly string[]).includes(v);
}

// --- Use cases --------------------------------------------------------------
export {
  createInvoiceDraft,
  createInvoiceDraftSchema,
  type CreateInvoiceDraftInput,
  type CreateInvoiceDraftError,
} from './application/use-cases/create-invoice-draft';

export {
  createEventInvoiceDraft,
  createEventInvoiceDraftSchema,
  type CreateEventInvoiceDraftInput,
  type CreateEventInvoiceDraftError,
  type CreateEventInvoiceDraftDeps,
} from './application/use-cases/create-event-invoice-draft';

export {
  issueInvoice,
  issueInvoiceSchema,
  type IssueInvoiceInput,
  type IssueInvoiceError,
  type IssueInvoiceSuccess,
} from './application/use-cases/issue-invoice';

// Cluster 5 (Finding 1) — observable auto-email dispatch outcome surfaced by
// the issuance + payment use-cases so the admin toast can warn on a silent
// "no email on file" skip.
export type { EmailDispatchOutcome } from './application/email-dispatch-outcome';

// 064 — one-shot draft→paid issuance for EVENT invoices (combined
// tax-invoice/receipt; no intermediate issued state). TIN →
// receipt_combined on the invoice stream; no-TIN → §105 receipt on the
// receipt stream (β, migration 0212).
export {
  issueEventInvoiceAsPaid,
  issueEventInvoiceAsPaidSchema,
  type IssueEventInvoiceAsPaidInput,
  type IssueEventInvoiceAsPaidError,
  type IssueEventInvoiceAsPaidDeps,
} from './application/use-cases/issue-event-invoice-as-paid';
// Wave-4 S19 — canonical error-code list (leaf module; client components
// needing the runtime array import the leaf path directly to keep the
// use-case's server-only graph out of the client bundle).
export { ISSUE_EVENT_INVOICE_AS_PAID_ERROR_CODES } from './application/use-cases/issue-event-invoice-as-paid-codes';

export {
  listInvoices,
  listInvoicesSchema,
  type ListInvoicesInput,
  type ListInvoicesOutput,
  listInvoicesPaged,
  listInvoicesPagedSchema,
  type ListInvoicesPagedInput,
  type ListInvoicesPagedOutput,
} from './application/use-cases/list-invoices';

export {
  getInvoicePdfSignedUrl,
  type GetInvoicePdfSignedUrlInput,
  type GetInvoicePdfSignedUrlError,
} from './application/use-cases/get-invoice-pdf-signed-url';

export {
  getReceiptPdfSignedUrl,
  type GetReceiptPdfSignedUrlInput,
  type GetReceiptPdfSignedUrlError,
} from './application/use-cases/get-receipt-pdf-signed-url';

// 088 US8 UX-B1 — OPTIONAL §80/1(5) zero-rate cert-scan upload + admin cert-view.
export {
  uploadZeroRateCert,
  isCertMimeType,
  type UploadZeroRateCertInput,
  type UploadZeroRateCertError,
  type UploadZeroRateCertOutput,
  type UploadZeroRateCertDeps,
} from './application/use-cases/upload-zero-rate-cert';
export {
  getZeroRateCertSignedUrl,
  type GetZeroRateCertSignedUrlInput,
  type GetZeroRateCertSignedUrlError,
  type GetZeroRateCertSignedUrlDeps,
} from './application/use-cases/get-zero-rate-cert-signed-url';

// 088 US8 UX-B2 — daily TTL sweep for ABANDONED/SUPERSEDED §80/1(5) cert-scan
// blobs (uploaded onto a draft that was never issued → never pinned). Composed
// by `src/lib/invoicing-cert-prune-deps.ts` for the cron route.
export {
  pruneOrphanedZeroRateCerts,
  parseZeroRateCertKey,
  ORPHAN_CERT_GRACE_MS,
  type PruneOrphanedZeroRateCertsInput,
  type PruneOrphanedZeroRateCertsOutput,
  type PruneOrphanedZeroRateCertsDeps,
} from './application/use-cases/prune-orphaned-zero-rate-certs';
export type { ZeroRateCertPruneRepo } from './application/ports/zero-rate-cert-prune-repo';

export {
  exportPaidInvoicesCsv,
  exportPaidInvoicesCsvSchema,
  type ExportPaidInvoicesCsvInput,
  type ExportPaidInvoicesCsvOutput,
  type ExportPaidInvoicesCsvError,
  type ExportPaidInvoicesCsvDeps,
  type PaymentMethodLookupPort,
} from './application/use-cases/export-paid-invoices-csv';

// 088 T065b (FR-031, ภพ.30 support) — period-scoped §86/4 RC register +
// §80/1(5) zero-rate sales list use-case + its narrow repo port.
export {
  listTaxDocumentRegister,
  listTaxDocumentRegisterSchema,
  type ListTaxDocumentRegisterInput,
  type ListTaxDocumentRegisterOutput,
  type ListTaxDocumentRegisterError,
  type ListTaxDocumentRegisterDeps,
  type TaxDocumentRegisterSummary,
  type PeriodOutputVat,
} from './application/use-cases/list-tax-document-register';
export type {
  TaxRegisterRepo,
  TaxRegisterKind,
} from './application/ports/tax-register-repo';

export {
  previewInvoiceDraft,
  type PreviewInvoiceDraftInput,
  type PreviewInvoiceDraftError,
} from './application/use-cases/preview-invoice-draft';

export {
  deleteInvoiceDraft,
  type DeleteInvoiceDraftInput,
  type DeleteInvoiceDraftError,
} from './application/use-cases/delete-invoice-draft';

export {
  getInvoice,
  type GetInvoiceInput,
  type GetInvoiceError,
} from './application/use-cases/get-invoice';

export {
  recordPayment,
  recordPaymentSchema,
  type RecordPaymentInput,
  type RecordPaymentError,
  type RecordPaymentSuccess,
} from './application/use-cases/record-payment';

// T166-05 — async receipt PDF worker callback. Routed by the F4
// outbox dispatcher when a `receipt_pdf_render` row commits.
export {
  renderReceiptPdf,
  type RenderReceiptPdfInput,
  type RenderReceiptPdfError,
  type RenderReceiptPdfDeps,
} from './application/use-cases/render-receipt-pdf';

export {
  issueCreditNote,
  issueCreditNoteSchema,
  type IssueCreditNoteInput,
  type IssueCreditNoteError,
  type IssueCreditNoteSuccess,
  type CreditNoteEmailDelivery,
} from './application/use-cases/issue-credit-note';

export {
  voidInvoice,
  voidInvoiceSchema,
  type VoidInvoiceInput,
  type VoidInvoiceError,
} from './application/use-cases/void-invoice';

// 106-void-on-reissue — issueInvoice + best-effort supersede-void of the
// member's strictly-older outstanding new-flow membership bills.
export {
  issueMembershipBill,
  type IssueMembershipBillDeps,
  type IssueMembershipBillSuccess,
} from './application/use-cases/issue-membership-bill';

export {
  getCreditNote,
  type GetCreditNoteInput,
  type GetCreditNoteError,
} from './application/use-cases/get-credit-note';

export {
  listCreditNotes,
  type ListCreditNotesInput,
  type ListCreditNotesOutput,
  type ListCreditNotesRow,
  type ListCreditNotesError,
} from './application/use-cases/list-credit-notes';

export {
  getCreditNotePdfSignedUrl,
  type GetCreditNotePdfSignedUrlInput,
  type GetCreditNotePdfSignedUrlError,
} from './application/use-cases/get-credit-note-pdf-signed-url';

export {
  asCreditNoteId,
  parseCreditNoteId,
  type CreditNote,
  type CreditNoteId,
} from './domain/credit-note';

export {
  updateInvoiceDraft,
  updateInvoiceDraftSchema,
  type UpdateInvoiceDraftInput,
  type UpdateInvoiceDraftError,
} from './application/use-cases/update-invoice-draft';

export {
  updateTenantInvoiceSettings,
  updateTenantInvoiceSettingsSchema,
  type UpdateTenantInvoiceSettingsInput,
  type UpdateTenantInvoiceSettingsError,
} from './application/use-cases/update-tenant-invoice-settings';

export {
  uploadTenantLogo,
  LOGO_HISTORY_CAP,
  type UploadTenantLogoInput,
  type UploadTenantLogoError,
} from './application/use-cases/upload-tenant-logo';

export {
  getTenantTaxPolicy,
  type TenantTaxPolicy,
} from './application/use-cases/get-tenant-tax-policy';

export {
  listInvoicesByMember,
  listInvoicesByMemberSchema,
  type ListInvoicesByMemberInput,
  type ListInvoicesByMemberOutput,
  type ListInvoicesByMemberError,
} from './application/use-cases/list-invoices-by-member';

export {
  resendPdf,
  type ResendPdfInput,
  type ResendPdfOutput,
  type ResendPdfError,
  type ResendPdfActor,
} from './application/use-cases/resend-pdf';

export {
  deriveOverdue,
  computeIsOverdue,
  maybeEmitOverdueDetected,
  type InvoiceWithOverdue,
} from './application/use-cases/derive-overdue';

// --- F5 bridge use-cases (post-critique R2-E16 explicit gate) --------------
// The 3 wrappers below give F5 (online payment, webhook reconciliation,
// refund flow) a stable F4 surface to bind against. Each wrapper
// composes its F4 deps internally via `make*Deps(tenantId)` — see
// `specs/009-online-payment/tasks.md` § "Implementation Decisions" #6.
export {
  markPaidFromProcessor,
  type MarkPaidFromProcessorInput,
  type MarkPaidFromProcessorError,
  type ProcessorPaymentMethod,
} from './application/use-cases/mark-paid-from-processor';

export {
  issueCreditNoteFromRefund,
  type IssueCreditNoteFromRefundInput,
  type IssueCreditNoteFromRefundOutput,
  type IssueCreditNoteFromRefundError,
} from './application/use-cases/issue-credit-note-from-refund';
// Alias note: `IssueCreditNoteFromRefundOutput` = F4's `CreditNote`
// (sub-batch B rewire 2026-04-23). Earlier stub used a lightweight
// DTO; the real impl returns the full F4 aggregate so F5 callers can
// surface the new document number without a second DB roundtrip.

export {
  getInvoiceForPayment,
  type GetInvoiceForPaymentInput,
  type InvoiceForPayment,
  type GetInvoiceForPaymentError,
  type GetInvoiceForPaymentDeps,
} from './application/use-cases/get-invoice-for-payment';
export type {
  OverdueAuditPort,
  OverdueDetectedEvent,
} from './application/ports/overdue-audit-port';

// --- Composition-root factories --------------------------------------------
// Presentation / route handlers consume these to wire a per-request
// tenant-scoped dependency graph.
export {
  makeCreateInvoiceDraftDeps,
  makeCreateEventInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeIssueEventInvoiceAsPaidDeps,
  makeListInvoicesDeps,
  makeListTaxDocumentRegisterDeps,
  makeListInvoicesByMemberDeps,
  makeGetInvoicePdfSignedUrlDeps,
  makeGetReceiptPdfSignedUrlDeps,
  makeUploadZeroRateCertDeps,
  makeGetZeroRateCertSignedUrlDeps,
  makeExportPaidInvoicesCsvDeps,
  makePreviewInvoiceDraftDeps,
  makeDeleteInvoiceDraftDeps,
  makeGetInvoiceDeps,
  makeRecordPaymentDeps,
  makeRenderReceiptPdfDeps,
  makeVoidInvoiceDeps,
  makeIssueMembershipBillDeps,
  makeIssueCreditNoteDeps,
  makeGetCreditNoteDeps,
  makeListCreditNotesDeps,
  makeGetCreditNotePdfSignedUrlDeps,
  makeUpdateInvoiceDraftDeps,
  makeUpdateTenantInvoiceSettingsDeps,
  makeGetTenantTaxPolicyDeps,
  makeResendPdfDeps,
  makeOverdueAuditPort,
  makeF4AuditPort,
  isTenantInvoiceSetupComplete,
} from './application/invoicing-deps';

// `makeUploadTenantLogoDeps` is intentionally NOT re-exported from this
// barrel. It pulls in the Node-only `sharp` native dep (libvips →
// detect-libc → child_process); re-exporting it here causes Turbopack
// 16 to walk the F4 barrel into client bundles and break F8's
// renewals page (tier-filter-select.tsx → @/modules/renewals →
// load-cycle-detail → @/modules/invoicing). The single
// `/api/tenant-invoice-settings/logo` route handler deep-imports
// directly from `./application/make-upload-tenant-logo-deps`.

// --- R10-TY1: Infrastructure factories + adapters --------------------
//
// Re-export the F4 infrastructure factories + adapters so page-level
// wiring + cron routes + cross-module callers (F7 broadcasts, F8
// renewals) can compose F4 use-cases through this barrel instead of
// deep-importing `@/modules/invoicing/infrastructure/**`. Closes the
// R10 review-flagged Principle III barrel-leakage on 8+ call sites.
//
// `vercelBlobAdapter` re-exports the F4-owned Vercel Blob wrapper for
// any tenant-aware blob operation (PDF reads, logo uploads).
// `f4AuditAdapter` is the F4-side audit emitter (writes to
// `audit_log` with `retention_years` map). `receiptPdfRenderEnqueueAdapter`
// is the cron-trigger adapter for the async receipt-PDF worker.
export { drizzleTenantSettingsRepo } from './infrastructure/repos/drizzle-tenant-settings-repo';
// PR #173 round-2 review — narrow tx-threaded fiscal-year-start read for F8's
// re-anchor (avoids a nested pooled connection inside the settlement tx).
export { readFiscalYearStartMonthInTx } from './infrastructure/repos/drizzle-tenant-settings-repo';
export { makeDrizzleCreditNoteRepo } from './infrastructure/repos/drizzle-credit-note-repo';
export {
  makeDrizzleInvoiceRepo,
  makeDrizzleTaxRegisterRepo,
} from './infrastructure/repos/drizzle-invoice-repo';
export { makeDrizzleZeroRateCertPruneRepo } from './infrastructure/repos/drizzle-zero-rate-cert-prune-repo';
export { vercelBlobAdapter } from './infrastructure/adapters/vercel-blob-adapter';
export { f4AuditAdapter } from './infrastructure/adapters/audit-adapter';
export { receiptPdfRenderEnqueueAdapter } from './infrastructure/adapters/receipt-pdf-render-enqueue-adapter';
// 059-membership-suspension Task 12 — schema-level re-export mirroring
// the F5 `paymentsTable` precedent (`@/modules/payments` barrel): F8's
// `invoice-due-bridge-drizzle.ts` reads the `invoices` table directly
// (read-only cross-module query) rather than composing an F4 use-case,
// because no F4 use-case exposes "does this member have an unpaid,
// not-yet-due membership invoice" today. Re-exporting the table here
// (instead of a deep `./infrastructure/db/schema-invoices` import) keeps
// the cross-module dependency at the documented barrel surface.
export { invoices as invoicesTable } from './infrastructure/db/schema-invoices';
// Invoice-auto-email — referenced by the cron outbox dispatcher to
// render bilingual invoice/CN/receipt issued+resend notifications.
export {
  buildInvoiceAutoEmail,
  type InvoiceAutoEmailEventType,
} from './infrastructure/email/invoice-auto-email';
