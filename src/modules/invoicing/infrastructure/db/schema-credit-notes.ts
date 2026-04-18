/**
 * T012 — Drizzle schema for `credit_notes` (F4 aggregate root).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § credit_notes.
 * Single-state aggregate — immutable from creation. Partial-credit
 * accumulation invariant enforced at Application layer via
 * `SELECT … FOR UPDATE` on the parent invoice row.
 */
import {
  pgTable,
  text,
  uuid,
  smallint,
  integer,
  bigint,
  date,
  timestamp,
  char,
  jsonb,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const creditNotes = pgTable(
  'credit_notes',
  {
    tenantId: text('tenant_id').notNull(),
    creditNoteId: uuid('credit_note_id').notNull().defaultRandom(),
    originalInvoiceId: uuid('original_invoice_id').notNull(),

    fiscalYear: smallint('fiscal_year').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    documentNumber: text('document_number').notNull(),

    issueDate: date('issue_date').notNull(),
    issuedByUserId: uuid('issued_by_user_id').notNull(),
    reason: text('reason').notNull(),

    creditAmountSatang: bigint('credit_amount_satang', { mode: 'bigint' }).notNull(),
    vatSatang: bigint('vat_satang', { mode: 'bigint' }).notNull(),
    totalSatang: bigint('total_satang', { mode: 'bigint' }).notNull(),

    tenantIdentitySnapshot: jsonb('tenant_identity_snapshot').notNull(),
    memberIdentitySnapshot: jsonb('member_identity_snapshot').notNull(),

    pdfBlobKey: text('pdf_blob_key').notNull(),
    pdfSha256: char('pdf_sha256', { length: 64 }).notNull(),
    pdfTemplateVersion: smallint('pdf_template_version').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'credit_notes_pkey', columns: [table.tenantId, table.creditNoteId] }),
  ],
);

export type CreditNoteRow = typeof creditNotes.$inferSelect;
export type NewCreditNoteRow = typeof creditNotes.$inferInsert;
