/**
 * T012 — Drizzle schema for `invoices` (F4 aggregate root).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § invoices.
 *
 * Composite PK (tenant_id, invoice_id) matching F3 members convention.
 * Snapshot columns (tenant_identity_snapshot, member_identity_snapshot,
 * subtotal/vat/total satang, etc.) are locked by the
 * `invoices_enforce_immutability` trigger once `status != 'draft'`.
 */
import {
  pgTable,
  text,
  uuid,
  smallint,
  integer,
  bigint,
  boolean,
  date,
  timestamp,
  numeric,
  char,
  jsonb,
  pgEnum,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const invoiceStatusEnum = pgEnum('invoice_status', [
  'draft',
  'issued',
  'paid',
  'void',
  'credited',
  'partially_credited',
]);

export const invoices = pgTable(
  'invoices',
  {
    tenantId: text('tenant_id').notNull(),
    invoiceId: uuid('invoice_id').notNull().defaultRandom(),
    memberId: uuid('member_id').notNull(),
    planYear: smallint('plan_year').notNull(),
    planId: text('plan_id').notNull(),

    status: invoiceStatusEnum('status').notNull().default('draft'),
    draftByUserId: uuid('draft_by_user_id').notNull(),

    fiscalYear: smallint('fiscal_year'),
    sequenceNumber: integer('sequence_number'),
    documentNumber: text('document_number'),

    issueDate: date('issue_date'),
    dueDate: date('due_date'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),

    currency: char('currency', { length: 3 }).notNull().default('THB'),
    subtotalSatang: bigint('subtotal_satang', { mode: 'bigint' }),
    vatRateSnapshot: numeric('vat_rate_snapshot', { precision: 5, scale: 4 }),
    vatSatang: bigint('vat_satang', { mode: 'bigint' }),
    totalSatang: bigint('total_satang', { mode: 'bigint' }),
    creditedTotalSatang: bigint('credited_total_satang', { mode: 'bigint' })
      .notNull()
      .default(0n),

    proRatePolicySnapshot: text('pro_rate_policy_snapshot'),
    netDaysSnapshot: smallint('net_days_snapshot'),

    tenantIdentitySnapshot: jsonb('tenant_identity_snapshot'),
    memberIdentitySnapshot: jsonb('member_identity_snapshot'),

    paymentMethod: text('payment_method'),
    paymentReference: text('payment_reference'),
    paymentNotes: text('payment_notes'),
    paymentRecordedByUserId: uuid('payment_recorded_by_user_id'),

    voidReason: text('void_reason'),
    voidedByUserId: uuid('voided_by_user_id'),

    autoEmailOnIssue: boolean('auto_email_on_issue'),

    // Invoice PDF — frozen at issue time, never overwritten.
    pdfBlobKey: text('pdf_blob_key'),
    pdfSha256: char('pdf_sha256', { length: 64 }),
    pdfTemplateVersion: smallint('pdf_template_version'),
    // Receipt PDF — written by applyPayment, separate from invoice PDF
    // so the invoice's audit hash stays intact after payment (F4 final-
    // review C1). Permanently null for combined-mode tenants where the
    // receipt IS the invoice.
    receiptPdfBlobKey: text('receipt_pdf_blob_key'),
    receiptPdfSha256: char('receipt_pdf_sha256', { length: 64 }),
    receiptPdfTemplateVersion: smallint('receipt_pdf_template_version'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'invoices_pkey', columns: [table.tenantId, table.invoiceId] }),
  ],
);

export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
