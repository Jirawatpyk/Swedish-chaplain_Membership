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

export const documentTypeEnum = pgEnum('document_type', ['invoice', 'receipt', 'credit_note']);

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
