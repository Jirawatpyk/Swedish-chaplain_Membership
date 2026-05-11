/**
 * F8 Phase 2 Wave C · T024 — Drizzle schema for `consumed_link_tokens`.
 *
 * Single-use renewal-link token replay primitive (research.md R1).
 * Pairs with migration `drizzle/migrations/0093_f8_create_consumed_link_tokens_table.sql`.
 * Source of truth: data-model.md § 2.8.
 *
 * No UPDATE GRANT — rows are immutable once written. Weekly housekeeping
 * cron deletes rows >60d old (docs/runbooks/cron-jobs.md F8 token-prune).
 */
import {
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

export const consumedLinkTokens = pgTable(
  'consumed_link_tokens',
  {
    tenantId: text('tenant_id').notNull(),
    // SHA-256 digest = exactly 32 bytes (DB CHECK enforces).
    tokenSha256: bytea('token_sha256').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedByMemberId: uuid('consumed_by_member_id').notNull(),
    cycleId: uuid('cycle_id').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'consumed_link_tokens_pk',
      columns: [table.tenantId, table.tokenSha256],
    }),
    ageIdx: index('consumed_link_tokens_age_idx').on(table.consumedAt),
  }),
);

export type ConsumedLinkTokenRow = typeof consumedLinkTokens.$inferSelect;
export type ConsumedLinkTokenInsert = typeof consumedLinkTokens.$inferInsert;
