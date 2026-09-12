/**
 * F114 — Drizzle bindings for `member_change_requests` +
 * `member_change_request_fields` (migration 0300; data-model.md § 1–2).
 *
 * Drift-hygiene bindings, NOT a full mirror of the DDL: the partial unique
 * index, the indexes and the field-row composite FK are declared below so a
 * schema diff of this file can see them; the parent `UNIQUE (tenant_id, id)`,
 * the DEFERRABLE `replaced_by` self-FK, the eight NAMED `*_ck` table
 * constraints plus the ten anonymous column-level CHECKs, and the RLS
 * policies exist ONLY in migration 0300 (drizzle-kit cannot emit them).
 * `pnpm db:verify` never reads this file — `scripts/verify-schema.ts` runs
 * hand-written SQL against the live database and carries the canaries.
 * Inferred row types STAY in this file — the Domain
 * `ChangeRequest` / `ProposedField` are hand-declared and mapped in
 * `drizzle-change-request-repo.ts` (Principle III).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
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
      table.submittedAt.desc(),
    ),
    index('member_change_requests_rate_window_idx').on(
      table.tenantId,
      table.submittedByUserId,
      table.submittedAt,
    ),
    // 0302 (PR-1 review, Mig M-2) — the three FK columns 0300 left unindexed
    index('member_change_requests_tenant_decided_by_idx')
      .on(table.tenantId, table.decidedByUserId)
      .where(sql`decided_by_user_id IS NOT NULL`),
    index('member_change_requests_tenant_submitted_by_contact_idx').on(table.tenantId, table.submittedByContactId),
    index('member_change_requests_tenant_replaced_by_idx')
      .on(table.tenantId, table.replacedByRequestId)
      .where(sql`replaced_by_request_id IS NOT NULL`),
  ],
);

export const memberChangeRequestFields = pgTable(
  'member_change_request_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: text('tenant_id').notNull(),
    // composite (tenant_id, request_id) → the parent's UNIQUE (tenant_id, id):
    // declared in the table's extras below, never as a single-column
    // `.references()` (review round 1, migration I-1 — RI bypasses RLS)
    requestId: uuid('request_id').notNull(),
    fieldKey: text('field_key').notNull(),
    target: text('target').notNull(),
    seenValue: jsonb('seen_value'),
    proposedValue: jsonb('proposed_value'),
    outcome: text('outcome'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    affectsTaxDocuments: boolean('affects_tax_documents').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'member_change_request_fields_request_fk',
      columns: [table.tenantId, table.requestId],
      foreignColumns: [memberChangeRequests.tenantId, memberChangeRequests.id],
    }).onDelete('cascade'),
    uniqueIndex('member_change_request_fields_request_key_uniq').on(table.requestId, table.fieldKey),
    index('member_change_request_fields_tenant_request_idx').on(table.tenantId, table.requestId),
  ],
);

export type MemberChangeRequestRow = typeof memberChangeRequests.$inferSelect;
export type MemberChangeRequestInsert = typeof memberChangeRequests.$inferInsert;
export type MemberChangeRequestFieldRow = typeof memberChangeRequestFields.$inferSelect;
export type MemberChangeRequestFieldInsert = typeof memberChangeRequestFields.$inferInsert;
