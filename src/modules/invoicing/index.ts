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
  asInvoiceId,
  parseInvoiceId,
  isTerminal,
  canTransition,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
  type InvoiceIdError,
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
export { VatRate } from './domain/value-objects/vat-rate';
export { calculateVat } from './domain/policies/calculate-vat';
export {
  DocumentNumber,
  DOCUMENT_NUMBER_MAX_SEQ,
} from './domain/value-objects/document-number';
export {
  asFiscalYear,
  type FiscalYear,
} from './domain/value-objects/fiscal-year';
export type { TenantIdentitySnapshot } from './domain/value-objects/tenant-identity-snapshot';
export type { MemberIdentitySnapshot } from './domain/value-objects/member-identity-snapshot';
export { Sha256Hex } from './domain/value-objects/sha256-hex';
// `Sha256HexError` intentionally not exported — consumers receive the
// inline `{ ok:false, error:{kind,raw} }` shape from `Sha256Hex.parse`
// and rarely need the nominal type.

// --- Audit event types (for F3 timeline integration US7) --------------------
export type { F4AuditEventType, F4AuditEvent } from './application/ports/audit-port';

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
  issueInvoice,
  issueInvoiceSchema,
  type IssueInvoiceInput,
  type IssueInvoiceError,
} from './application/use-cases/issue-invoice';

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
} from './application/use-cases/record-payment';

export {
  issueCreditNote,
  issueCreditNoteSchema,
  type IssueCreditNoteInput,
  type IssueCreditNoteError,
} from './application/use-cases/issue-credit-note';

export {
  voidInvoice,
  voidInvoiceSchema,
  type VoidInvoiceInput,
  type VoidInvoiceError,
} from './application/use-cases/void-invoice';

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

// --- Composition-root factories --------------------------------------------
// Presentation / route handlers consume these to wire a per-request
// tenant-scoped dependency graph.
export {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeListInvoicesDeps,
  makeListInvoicesByMemberDeps,
  makeGetInvoicePdfSignedUrlDeps,
  makePreviewInvoiceDraftDeps,
  makeDeleteInvoiceDraftDeps,
  makeGetInvoiceDeps,
  makeRecordPaymentDeps,
  makeVoidInvoiceDeps,
  makeIssueCreditNoteDeps,
  makeGetCreditNoteDeps,
  makeListCreditNotesDeps,
  makeGetCreditNotePdfSignedUrlDeps,
  makeUpdateInvoiceDraftDeps,
  makeUpdateTenantInvoiceSettingsDeps,
  makeUploadTenantLogoDeps,
  makeGetTenantTaxPolicyDeps,
  makeResendPdfDeps,
  isTenantInvoiceSetupComplete,
} from './application/invoicing-deps';
