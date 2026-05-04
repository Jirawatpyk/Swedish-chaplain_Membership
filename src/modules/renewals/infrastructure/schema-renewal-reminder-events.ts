/**
 * F8 Phase 2 Wave C · T019 — Drizzle schema for `renewal_reminder_events`.
 *
 * Idempotent log of dispatched / attempted reminder steps. Pairs with
 * migration `drizzle/migrations/0088_f8_create_renewal_reminder_events_table.sql`.
 *
 * The 6 CHECK constraints (channel ∈ enum, status ∈ enum, channel-payload
 * discriminant, year_in_cycle ≥ 1, 4 status-timestamp invariants) +
 * RLS+FORCE policies live in the SQL migration only.
 *
 * Source of truth: data-model.md § 2.2.
 *
 * Domain entity (Wave D — schedule-step value object T033) + Drizzle
 * adapter (Phase 4+ when the dispatcher cron ships) consume this schema.
 */
import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { renewalCycles } from './schema-renewal-cycles';

export const renewalReminderEvents = pgTable(
  'renewal_reminder_events',
  {
    tenantId: text('tenant_id').notNull(),
    reminderEventId: uuid('reminder_event_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    cycleId: uuid('cycle_id').notNull(),

    // Step identity — free-form at DB; enumerated in Domain (Wave D T033).
    stepId: text('step_id').notNull(),
    // 'email' | 'task' (DB-level CHECK).
    channel: text('channel').notNull(),
    // Email channel only. NULL for task rows.
    templateId: text('template_id'),
    // Task channel only. NULL for email rows.
    taskType: text('task_type'),

    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    deliveryId: text('delivery_id'),
    // 4-state: 'pending' | 'sent' | 'skipped' | 'failed'.
    status: text('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    failureReason: text('failure_reason'),

    actorUserId: uuid('actor_user_id'),
    yearInCycle: smallint('year_in_cycle').notNull().default(1),

    // F8 Phase 4 Wave I2e (migration 0105) — FR-010a retry budget.
    // `retry_until` = dispatched_at + 24h on transient failures; NULL for
    // non-failed rows or permanent failures. `retry_exhausted_at` is set
    // by the retry use-case when transitioning to permanent failure
    // (idempotency primitive for permanent-audit emission).
    retryUntil: timestamp('retry_until', { withTimezone: true }),
    retryExhaustedAt: timestamp('retry_exhausted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'renewal_reminder_events_pk',
      columns: [table.tenantId, table.reminderEventId],
    }),
    cycleFk: foreignKey({
      name: 'renewal_reminder_events_cycle_fk',
      columns: [table.tenantId, table.cycleId],
      foreignColumns: [renewalCycles.tenantId, renewalCycles.cycleId],
    }).onDelete('cascade'),
    // Idempotency primitive — `INSERT … ON CONFLICT DO NOTHING`
    // against this index lets the dispatcher cron skip already-fired
    // steps without a SELECT round-trip.
    idemIdx: uniqueIndex('renewal_reminder_events_idem_idx').on(
      table.tenantId,
      table.cycleId,
      table.stepId,
      table.yearInCycle,
    ),
    recentIdx: index('renewal_reminder_events_recent_idx').on(
      table.tenantId,
      sql`${table.dispatchedAt} DESC`,
    ),
    failedIdx: index('renewal_reminder_events_failed_idx')
      .on(table.tenantId, table.status)
      .where(sql`status = 'failed'`),
    // Retry-eligible cursor — partial index keyed on (tenant_id,
    // retry_until) for the FR-010a retry pass query.
    retryEligibleIdx: index('renewal_reminder_events_retry_eligible_idx')
      .on(table.tenantId, table.retryUntil)
      .where(sql`status = 'failed' AND retry_until IS NOT NULL`),
  }),
);

export type RenewalReminderEventRow = typeof renewalReminderEvents.$inferSelect;
export type RenewalReminderEventInsert =
  typeof renewalReminderEvents.$inferInsert;
