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
  getCreditNote,
  type GetCreditNoteInput,
  type GetCreditNoteError,
} from './application/use-cases/get-credit-note';

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
  type UploadTenantLogoInput,
  type UploadTenantLogoError,
} from './application/use-cases/upload-tenant-logo';

export {
  getTenantTaxPolicy,
  type TenantTaxPolicy,
} from './application/use-cases/get-tenant-tax-policy';

// --- Composition-root factories --------------------------------------------
// Presentation / route handlers consume these to wire a per-request
// tenant-scoped dependency graph.
export {
  makeCreateInvoiceDraftDeps,
  makeIssueInvoiceDeps,
  makeListInvoicesDeps,
  makeGetInvoicePdfSignedUrlDeps,
  makePreviewInvoiceDraftDeps,
  makeDeleteInvoiceDraftDeps,
  makeGetInvoiceDeps,
  makeRecordPaymentDeps,
  makeIssueCreditNoteDeps,
  makeGetCreditNoteDeps,
  makeGetCreditNotePdfSignedUrlDeps,
  makeUpdateInvoiceDraftDeps,
  makeUpdateTenantInvoiceSettingsDeps,
  makeUploadTenantLogoDeps,
  makeGetTenantTaxPolicyDeps,
  isTenantInvoiceSetupComplete,
} from './application/invoicing-deps';
