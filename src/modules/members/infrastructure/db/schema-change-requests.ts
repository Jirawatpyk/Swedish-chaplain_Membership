/**
 * F114 — Drizzle bindings for `member_change_requests` +
 * `member_change_request_fields` (migration 0300; data-model.md § 1–2).
 *
 * Mirrors the hand-written DDL exactly. The composite FKs, the CHECK
 * constraints, the partial unique index and the RLS policies are declared in
 * the migration (drizzle-kit cannot emit them); the indexes below are listed
 * for drift hygiene only. Inferred row types STAY in this file — the Domain
 * `ChangeRequest` / `ProposedField` are hand-declared and mapped in
 * `drizzle-change-request-repo.ts` (Principle III).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const memberChangeRequests = pgTable(
  'member_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    memberId: uuid('member_id').notNull(),
    submittedByUserId: uuid('submitted_by_user_id').notNull(),
    submittedByContactId: uuid('submitted_by_contact_id').notNull(),
    submitterRoleAtSubmission: text('submitter_role_at_submission').notNull(),
    scope: text('scope').notNull(),
    state: text('state').notNull(),
    outcome: text('outcome'),
    withdrawnReason: text('withdrawn_reason'),
    replacedByRequestId: uuid('replaced_by_request_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    staffNotifiedAt: timestamp('staff_notified_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedByUserId: uuid('decided_by_user_id'),
    decisionReason: text('decision_reason'),
    decisionNote: text('decision_note'),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    outcomeAcknowledgedAt: timestamp('outcome_acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // R3 — one PENDING request per submitting person (partial unique index).
    uniqueIndex('member_change_requests_one_pending_per_submitter')
      .on(table.tenantId, table.submittedByUserId)
      .where(sql`state = 'pending'`),
    index('member_change_requests_tenant_state_submitted_idx').on(
      table.tenantId,
      table.state,
      table.submittedAt.desc(),
      table.id.desc(),
    ),
    index('member_change_requests_tenant_member_idx').on(
      table.tenantId,
      table.memberId,
      table.submittedAt,
    ),
    index('member_change_requests_rate_window_idx').on(
      table.tenantId,
      table.submittedByUserId,
      table.submittedAt,
    ),
  ],
);

export const memberChangeRequestFields = pgTable(
  'member_change_request_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => memberChangeRequests.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    target: text('target').notNull(),
    seenValue: jsonb('seen_value'),
    proposedValue: jsonb('proposed_value'),
    outcome: text('outcome'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    affectsTaxDocuments: boolean('affects_tax_documents').notNull(),
  },
  (table) => [
    uniqueIndex('member_change_request_fields_request_key_uniq').on(table.requestId, table.fieldKey),
    index('member_change_request_fields_tenant_request_idx').on(table.tenantId, table.requestId),
  ],
);

export type MemberChangeRequestRow = typeof memberChangeRequests.$inferSelect;
export type MemberChangeRequestInsert = typeof memberChangeRequests.$inferInsert;
export type MemberChangeRequestFieldRow = typeof memberChangeRequestFields.$inferSelect;
export type MemberChangeRequestFieldInsert = typeof memberChangeRequestFields.$inferInsert;
