/**
 * F8 Phase 2 Wave C · T023 — Drizzle schema for `renewal_escalation_tasks`.
 *
 * Pairs with migration `drizzle/migrations/0092_f8_create_renewal_escalation_tasks_table.sql`.
 * Source of truth: data-model.md § 2.7.
 */
import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from './schema-renewal-cycles';

export const renewalEscalationTasks = pgTable(
  'renewal_escalation_tasks',
  {
    tenantId: text('tenant_id').notNull(),
    taskId: uuid('task_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    memberId: uuid('member_id').notNull(),
    // NULL for non-cycle tasks (e.g. verify_pending_tier_upgrade).
    cycleId: uuid('cycle_id'),
    taskType: text('task_type').notNull(),
    // 'admin' | 'manager' | 'executive_director'.
    assignedToRole: text('assigned_to_role').notNull(),
    assignedToUserId: uuid('assigned_to_user_id'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    // 3-state: 'open' | 'done' | 'skipped'.
    status: text('status').notNull().default('open'),
    outcomeNote: text('outcome_note'),
    skippedReason: text('skipped_reason'),
    closedByUserId: uuid('closed_by_user_id'),
    relatedSuggestionId: uuid('related_suggestion_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: 'renewal_escalation_tasks_pk',
      columns: [table.tenantId, table.taskId],
    }),
    memberFk: foreignKey({
      name: 'renewal_escalation_tasks_member_fk',
      columns: [table.tenantId, table.memberId],
      foreignColumns: [members.tenantId, members.memberId],
    }).onDelete('cascade'),
    cycleFk: foreignKey({
      name: 'renewal_escalation_tasks_cycle_fk',
      columns: [table.tenantId, table.cycleId],
      foreignColumns: [renewalCycles.tenantId, renewalCycles.cycleId],
    }),
    queueIdx: index('renewal_escalation_tasks_queue_idx').on(
      table.tenantId,
      table.status,
      table.dueAt,
    ),
    perUserIdx: index('renewal_escalation_tasks_per_user_idx')
      .on(table.tenantId, table.assignedToUserId, table.status)
      .where(sql`status = 'open'`),
    openIdemUniq: uniqueIndex('renewal_escalation_tasks_open_idem_idx')
      .on(table.tenantId, table.memberId, table.cycleId, table.taskType)
      .where(sql`status = 'open'`),
  }),
);

export type RenewalEscalationTaskRow =
  typeof renewalEscalationTasks.$inferSelect;
export type RenewalEscalationTaskInsert =
  typeof renewalEscalationTasks.$inferInsert;
