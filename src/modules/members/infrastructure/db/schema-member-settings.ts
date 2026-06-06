/**
 * F-member-number — per-tenant member-number display prefix config.
 *
 * Immutable after first member is created (no UPDATE use-case in MVP).
 * Prefix is seeded in migration 0209 for the SweCham tenant.
 * Format: ^[A-Z][A-Z0-9]{0,7}$ — 1–8 chars, uppercase alpha + digits.
 * Default 'M' applies for future tenants with no explicit seed row.
 *
 * RLS ENABLE + FORCE + chamber_app policy declared in migration 0209.
 */
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const tenantMemberSettings = pgTable('tenant_member_settings', {
  tenantId: text('tenant_id').primaryKey(),
  memberNumberPrefix: text('member_number_prefix').notNull().default('M'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantMemberSettingsRow =
  typeof tenantMemberSettings.$inferSelect;
export type TenantMemberSettingsInsert =
  typeof tenantMemberSettings.$inferInsert;
