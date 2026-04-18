/**
 * T012 — Drizzle schema for `invoice_lines` (F4).
 *
 * Migration: drizzle/migrations/0019_invoicing_tables.sql § invoice_lines.
 * Child entity of Invoice — cascade-deleted when parent is a draft; once
 * issued, parent's immutability trigger blocks any Invoice mutation and
 * lines should not be touched (the Domain aggregate enforces this at
 * the use-case layer).
 */
import {
  pgTable,
  text,
  uuid,
  smallint,
  bigint,
  numeric,
  timestamp,
  pgEnum,
  primaryKey,
} from 'drizzle-orm/pg-core';

export const invoiceLineKindEnum = pgEnum('invoice_line_kind', [
  'membership_fee',
  'registration_fee',
]);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    tenantId: text('tenant_id').notNull(),
    lineId: uuid('line_id').notNull().defaultRandom(),
    invoiceId: uuid('invoice_id').notNull(),
    kind: invoiceLineKindEnum('kind').notNull(),
    descriptionTh: text('description_th').notNull(),
    descriptionEn: text('description_en').notNull(),
    unitPriceSatang: bigint('unit_price_satang', { mode: 'bigint' }).notNull(),
    quantity: numeric('quantity', { precision: 10, scale: 4 }).notNull().default('1'),
    proRateFactor: numeric('pro_rate_factor', { precision: 6, scale: 4 }),
    totalSatang: bigint('total_satang', { mode: 'bigint' }).notNull(),
    position: smallint('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'invoice_lines_pkey', columns: [table.tenantId, table.lineId] }),
  ],
);

export type InvoiceLineRow = typeof invoiceLines.$inferSelect;
export type NewInvoiceLineRow = typeof invoiceLines.$inferInsert;
