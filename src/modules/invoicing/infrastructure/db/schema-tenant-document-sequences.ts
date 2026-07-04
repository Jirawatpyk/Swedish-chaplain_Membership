/**
 * T012 — Drizzle schema for `tenant_document_sequences` (F4).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § tenant_document_sequences.
 *
 * Composite PK (tenant_id, document_type, fiscal_year) — one counter
 * per allocator stream. Read/updated inside the transactional issue
 * path via `SELECT … FOR UPDATE` + advisory lock (see data-model.md
 * § 2.5 allocation protocol).
 */
import { pgTable, text, smallint, integer, timestamp, pgEnum, primaryKey } from 'drizzle-orm/pg-core';

// 088-invoice-tax-flow-redesign (T005, migration 0230) — two new streams:
//   'bill'        — the non-§87 ใบแจ้งหนี้ stream (prefix SC), allocated at
//                   issue; gaps are legal (NOT under §87 no-gaps).
//   'receipt_105' — the SEPARATE §105 RE register for event-without-TIN
//                   receipts (prefix RE), keeping the RC §86/4/§87 register
//                   pure; sequential/tidy but NOT under §87 no-gaps.
export const documentTypeEnum = pgEnum('document_type', [
  'invoice',
  'receipt',
  'credit_note',
  'bill',
  'receipt_105',
]);

export const tenantDocumentSequences = pgTable(
  'tenant_document_sequences',
  {
    tenantId: text('tenant_id').notNull(),
    documentType: documentTypeEnum('document_type').notNull(),
    fiscalYear: smallint('fiscal_year').notNull(),
    nextSequenceNumber: integer('next_sequence_number').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'tenant_document_sequences_pkey',
      columns: [table.tenantId, table.documentType, table.fiscalYear],
    }),
  ],
);

export type TenantDocumentSequencesRow = typeof tenantDocumentSequences.$inferSelect;
export type NewTenantDocumentSequencesRow = typeof tenantDocumentSequences.$inferInsert;
