/**
 * Barrel for F4 Drizzle table definitions (Infrastructure only).
 *
 * Re-exports the 5 F4 tables so repos and tests can import from a
 * single path. NEVER imported from Domain or Application — the
 * ESLint rule on Application ports (see eslint.config.mjs) prevents
 * value imports from @modules-slash-anything-slash-infrastructure;
 * type-only is allowed for DI wiring.
 */
export {
  tenantInvoiceSettings,
  numberingResetCadenceEnum,
  proRatePolicyEnum,
  type TenantInvoiceSettingsRow,
  type NewTenantInvoiceSettingsRow,
} from './schema-tenant-invoice-settings';
export {
  tenantDocumentSequences,
  documentTypeEnum,
  type TenantDocumentSequencesRow,
  type NewTenantDocumentSequencesRow,
} from './schema-tenant-document-sequences';
export {
  invoices,
  invoiceStatusEnum,
  type InvoiceRow,
  type NewInvoiceRow,
} from './schema-invoices';
export {
  invoiceLines,
  invoiceLineKindEnum,
  type InvoiceLineRow,
  type NewInvoiceLineRow,
} from './schema-invoice-lines';
export {
  creditNotes,
  type CreditNoteRow,
  type NewCreditNoteRow,
} from './schema-credit-notes';
