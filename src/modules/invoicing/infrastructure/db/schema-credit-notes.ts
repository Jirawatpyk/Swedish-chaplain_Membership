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
  boolean,
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

    // COMP-1 US3-B — retryable PDF-blob purge marker, set ONLY by the member-
    // invoice redaction cron after a fully successful blob purge (migration 0227).
    // NULL = purge not yet completed. Exempt (with member_identity_snapshot) under
    // the `app.allow_pii_redaction` GUC; locked on every normal write path.
    piiBlobPurgedAt: timestamp('pii_blob_purged_at', { withTimezone: true }),

    // F5 extension (migration 0038) — nullable FK → refunds(id). NULL for
    // F4-manual credit notes; non-NULL for F5-origin (refund-triggered)
    // credit notes. Projects through row-to-domain mapping.
    sourceRefundId: text('source_refund_id'),

    // M1 (plan-change-ux, business decision Option 1b) — does this credit note
    // LEAVE the member's membership coverage intact for the credited period?
    // Set ONLY by the issue-credit-note use case, WRITE-ONCE at INSERT
    // (credit_notes is immutable — no UPDATE path). TRUE only for an F4-manual
    // FULL membership credit note with `membershipEffect: 'keep'` — a paperwork
    // correction where the member was NOT refunded, so their coverage is
    // RETAINED (the settling invoice flips to 'credited' for §86/10 paperwork,
    // but the renewal coverage predicate must NOT retract the period). FALSE for
    // every other credit note: F5 real refunds (money returned → retract),
    // `cancel_membership` withdrawals, partial credits, and event credits.
    // DEFAULT FALSE = today's #24 behaviour; every existing membership CN is an
    // F5-refund, so FALSE is the correct backfill (no data migration needed).
    // The renewal `effectivePaidCoverageSql` predicate + the L1 pipeline read
    // model consult this column via a correlated EXISTS on the settling invoice.
    retainsCoverage: boolean('retains_coverage').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'credit_notes_pkey', columns: [table.tenantId, table.creditNoteId] }),
  ],
);

export type CreditNoteRow = typeof creditNotes.$inferSelect;
export type NewCreditNoteRow = typeof creditNotes.$inferInsert;
