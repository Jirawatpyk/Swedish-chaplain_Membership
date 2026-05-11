/**
 * F8 Phase 2 Wave C · T021 — Drizzle schema for `at_risk_outreach`.
 *
 * Pairs with migration `drizzle/migrations/0090_f8_create_at_risk_outreach_table.sql`.
 * Source of truth: data-model.md § 2.5.
 */
import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { members } from '@/modules/members/infrastructure/db/schema-members';

export const atRiskOutreach = pgTable(
  'at_risk_outreach',
  {
    tenantId: text('tenant_id').notNull(),
    outreachId: uuid('outreach_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    memberId: uuid('member_id').notNull(),
    // 'email' | 'phone' | 'meeting'.
    channel: text('channel').notNull(),
    // Email channel only.
    templateId: text('template_id'),
    // Free-text ≤500 chars (DB CHECK).
    outcomeNote: text('outcome_note'),
    actorUserId: uuid('actor_user_id').notNull(),
    relatedAuditEventId: uuid('related_audit_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'at_risk_outreach_pk',
      columns: [table.tenantId, table.outreachId],
    }),
    memberFk: foreignKey({
      name: 'at_risk_outreach_member_fk',
      columns: [table.tenantId, table.memberId],
      foreignColumns: [members.tenantId, members.memberId],
    }).onDelete('cascade'),
    memberTimelineIdx: index('at_risk_outreach_member_timeline_idx').on(
      table.tenantId,
      table.memberId,
      sql`${table.createdAt} DESC`,
    ),
  }),
);

export type AtRiskOutreachRow = typeof atRiskOutreach.$inferSelect;
export type AtRiskOutreachInsert = typeof atRiskOutreach.$inferInsert;
