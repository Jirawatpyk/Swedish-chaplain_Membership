/**
 * F-member-number — per-tenant lifetime member-number counter.
 *
 * Separate from F4 `tenant_document_sequences` which is
 * (tenant_id, document_type, fiscal_year) and resets yearly per §87.
 * This counter is lifetime + never resets (gaps OK, no §87 obligation).
 *
 * RLS ENABLE + FORCE + chamber_app policy declared in migration 0209.
 * This file is Drizzle schema only — drizzle-kit cannot emit RLS.
 */
import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tenantMemberSequences = pgTable('tenant_member_sequences', {
  tenantId: text('tenant_id').primaryKey(),
  lastNumber: integer('last_number').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantMemberSequenceRow =
  typeof tenantMemberSequences.$inferSelect;
export type TenantMemberSequenceInsert =
  typeof tenantMemberSequences.$inferInsert;
