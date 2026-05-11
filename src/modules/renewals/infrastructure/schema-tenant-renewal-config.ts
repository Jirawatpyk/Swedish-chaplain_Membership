/**
 * F8 Phase 2 Wave C · T020 — Drizzle schema for tenant_renewal_settings
 * + tenant_renewal_schedule_policies.
 *
 * Pairs with migration `drizzle/migrations/0089_f8_create_tenant_renewal_config_tables.sql`.
 * RLS+FORCE + CHECK constraints + triggers + SweCham fixtures live in
 * the SQL migration only.
 *
 * Source of truth: data-model.md § 2.3 + § 2.4.
 */
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const tenantRenewalSettings = pgTable('tenant_renewal_settings', {
  tenantId: text('tenant_id').primaryKey(),
  gracePeriodDays: smallint('grace_period_days').notNull().default(14),
  autoUpgradeEnabled: boolean('auto_upgrade_enabled').notNull().default(true),
  minTenureDaysForAtRisk: smallint('min_tenure_days_for_at_risk')
    .notNull()
    .default(30),
  dispatchCronEnabled: boolean('dispatch_cron_enabled').notNull().default(true),
  replyToEmail: text('reply_to_email'),
  replyToDisplayName: text('reply_to_display_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantRenewalSettingsRow =
  typeof tenantRenewalSettings.$inferSelect;
export type TenantRenewalSettingsInsert =
  typeof tenantRenewalSettings.$inferInsert;

/**
 * Single step in a tier-bucket schedule policy. Matches the JSONB array
 * shape stored in `tenant_renewal_schedule_policies.steps_jsonb`.
 *
 * `offset_days` is signed: negative = before expires_at, positive = after.
 */
export interface ScheduleStepJson {
  readonly step_id: string;
  readonly offset_days: number;
  readonly channel: 'email' | 'task';
  readonly template_id?: string;
  readonly task_type?: string;
  readonly assignee_role?: 'admin' | 'manager' | 'executive_director';
}

export const tenantRenewalSchedulePolicies = pgTable(
  'tenant_renewal_schedule_policies',
  {
    tenantId: text('tenant_id').notNull(),
    // 'thai_alumni' | 'start_up' | 'regular' | 'premium' | 'partnership'.
    tierBucket: text('tier_bucket').notNull(),
    stepsJsonb: jsonb('steps_jsonb')
      .$type<readonly ScheduleStepJson[]>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'tenant_renewal_schedule_policies_pk',
      columns: [table.tenantId, table.tierBucket],
    }),
  }),
);

export type TenantRenewalSchedulePolicyRow =
  typeof tenantRenewalSchedulePolicies.$inferSelect;
export type TenantRenewalSchedulePolicyInsert =
  typeof tenantRenewalSchedulePolicies.$inferInsert;
