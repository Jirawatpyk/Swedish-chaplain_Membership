/**
 * F8 Phase 2 Wave C · T017 — Drizzle schema for `scheduled_plan_changes`.
 *
 * F2 cross-module table — F2 owns the LOGICAL schema (use-cases live in
 * `src/modules/plans/application/`), F8 owns the migration delivery
 * (per F7 precedent of F8-owns-all-9-migrations + research.md R13).
 *
 * Pairs with migration `drizzle/migrations/0086_f8_create_scheduled_plan_changes_table.sql`.
 * RLS+FORCE policies + CHECK constraints + triggers live in the SQL
 * migration only — drizzle-kit does not emit them from the TypeScript
 * schema (same pattern as F2's `schema.ts`).
 *
 * Source of truth: data-model.md § 2.9.
 */
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const scheduledPlanChanges = pgTable(
  'scheduled_plan_changes',
  {
    tenantId: text('tenant_id').notNull(),
    scheduledChangeId: uuid('scheduled_change_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    memberId: uuid('member_id').notNull(),
    effectiveAtCycleId: uuid('effective_at_cycle_id').notNull(),
    fromPlanId: text('from_plan_id').notNull(),
    toPlanId: text('to_plan_id').notNull(),
    scheduledByUserId: uuid('scheduled_by_user_id').notNull(),
    reason: text('reason'),
    // 4-state machine: 'pending' | 'applied' | 'superseded' | 'cancelled'.
    // CHECK constraint at DB level lives in migration 0086 SQL.
    status: text('status').notNull().default('pending'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'scheduled_plan_changes_pk',
      columns: [table.tenantId, table.scheduledChangeId],
    }),
    // Partial unique — at-most-one-pending per (tenant, member, cycle).
    // The `where` clause filters terminal rows so the audit trail can carry
    // many of them. Drizzle emits the WHERE via the SQL helper; the migration
    // SQL also defines this index explicitly so the names line up.
    pendingUniq: uniqueIndex('scheduled_plan_changes_pending_uniq')
      .on(table.tenantId, table.memberId, table.effectiveAtCycleId)
      .where(sql`status = 'pending'`),
    memberCycleIdx: index('scheduled_plan_changes_member_cycle_idx').on(
      table.tenantId,
      table.memberId,
      table.effectiveAtCycleId,
    ),
  }),
);

export type ScheduledPlanChangeRow = typeof scheduledPlanChanges.$inferSelect;
export type ScheduledPlanChangeInsert = typeof scheduledPlanChanges.$inferInsert;
