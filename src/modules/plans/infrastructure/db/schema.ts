/**
 * F2 Plans + Fee Config — Drizzle schema.
 *
 * Two tables:
 *   - `membership_plans`  — catalogue of tier definitions, year-versioned, soft-deletable
 *   - `tenant_fee_config` — per-tenant authoritative currency + VAT + registration fee
 *
 * Plus 8 Postgres enums (plan_category, member_type_scope, etc.) for
 * typed columns on the plans table.
 *
 * **RLS policies are not expressed in the Drizzle schema** — drizzle-kit
 * does not emit `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` for
 * `pgTable` definitions. They are hand-appended to the generated SQL
 * migration (`drizzle/migrations/0006_plans_and_fee_config.sql`) as a
 * raw SQL block. See data-model.md § 3.2 + research.md § 2.
 *
 * See also data-model.md § 3 for the authoritative column list and
 * § 4 for the typed JSONB payloads.
 */

import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '../../domain/benefit-matrix';
import type { LocaleText } from '../../domain/locale-text';

// --- Enums --------------------------------------------------------------------

export const planCategoryEnum = pgEnum('plan_category', [
  'corporate',
  'partnership',
]);

export const memberTypeScopeEnum = pgEnum('member_type_scope', [
  'company',
  'individual',
  'both',
]);

export const directoryListingSizeEnum = pgEnum('directory_listing_size', [
  'full_page',
  'half_page',
  'eighth_page',
]);

export const eventDiscountScopeEnum = pgEnum('event_discount_scope', [
  'all_employees',
  'one_ticket_per_event',
  'none',
]);

export const websitePageTypeEnum = pgEnum('website_page_type', [
  'member_news_update',
  'smes_spotlight',
  'student_intern_cv',
]);

export const homepageLogoCategoryEnum = pgEnum('homepage_logo_category', [
  'premium',
  'large',
  'regular',
  'start_up',
]);

export const directoryAdPositionEnum = pgEnum('directory_ad_position', [
  'pages_1_and_2',
  'first_pages',
  'first_10_pages',
]);

export const videoFrequencyScopeEnum = pgEnum('video_frequency_scope', [
  'all_events',
  'three_selected_events',
]);

// --- membership_plans ---------------------------------------------------------

export const membershipPlans = pgTable(
  'membership_plans',
  {
    // Tenancy (MTA+STD — no FK to a tenants table in F2, F10 retrofits)
    tenantId: text('tenant_id').notNull(),

    // Identity
    planId: text('plan_id').notNull(),
    planYear: integer('plan_year').notNull(),

    // Display
    planName: jsonb('plan_name').$type<LocaleText>().notNull(),
    description: jsonb('description')
      .$type<LocaleText>()
      .notNull()
      .default(sql`'{"en":""}'::jsonb`),
    sortOrder: integer('sort_order').notNull().default(100),

    // Classification
    planCategory: planCategoryEnum('plan_category').notNull(),
    memberTypeScope: memberTypeScopeEnum('member_type_scope').notNull(),

    // Pricing — bigint minor units (NOT integer — SweCham Premium's
    // min_turnover is 10B satang = 100M THB, which overflows int32's
    // ~2.1B ceiling). bigint is 8 bytes = ~9.2 × 10^18 headroom.
    // Mode 'number' returns a plain JS number — values up to
    // Number.MAX_SAFE_INTEGER (~9 quadrillion) round-trip safely,
    // well above any plausible annual fee.
    annualFeeMinorUnits: bigint('annual_fee_minor_units', { mode: 'number' }).notNull(),

    // Partnership ↔ Corporate bundling (null for corporate, non-null for partnership)
    includesCorporatePlanId: text('includes_corporate_plan_id'),

    // Eligibility (nullable — each constraint is optional). Turnover
    // values are money-like and use bigint for the same reason as
    // annualFeeMinorUnits. max_duration_years + max_member_age stay
    // as integer because they're small cardinal counts.
    minTurnoverMinorUnits: bigint('min_turnover_minor_units', { mode: 'number' }),
    maxTurnoverMinorUnits: bigint('max_turnover_minor_units', { mode: 'number' }),
    maxDurationYears: integer('max_duration_years'),
    maxMemberAge: integer('max_member_age'),

    // Benefits — typed JSONB, Domain validator enforces shape before insert
    benefitMatrix: jsonb('benefit_matrix').$type<BenefitMatrix>().notNull(),

    // State
    isActive: boolean('is_active').notNull().default(true),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updatedBy: uuid('updated_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    primaryKey({
      name: 'membership_plans_pkey',
      columns: [table.tenantId, table.planId, table.planYear],
    }),
    // Partial indexes — RLS rewrites `SELECT` into a `WHERE tenant_id = <ctx>`
    // so the multi-column index is hit first; `deleted_at IS NULL` keeps the
    // common active-catalogue path off soft-deleted rows.
    index('membership_plans_tenant_year_idx')
      .on(table.tenantId, table.planYear)
      .where(sql`deleted_at IS NULL`),
    index('membership_plans_tenant_category_idx')
      .on(table.tenantId, table.planCategory)
      .where(sql`deleted_at IS NULL`),
    index('membership_plans_tenant_active_idx')
      .on(table.tenantId, table.isActive)
      .where(sql`deleted_at IS NULL`),
  ],
);

// --- tenant_fee_config --------------------------------------------------------

export const tenantFeeConfig = pgTable('tenant_fee_config', {
  tenantId: text('tenant_id').primaryKey(),
  // ISO 4217 — single authoritative currency for the tenant's catalogue.
  // Immutable in F2 once plans exist (critique R1, enforced in Application).
  currencyCode: text('currency_code').notNull(),
  // numeric(5,4) → 0.0700 = 7%
  vatRate: numeric('vat_rate', { precision: 5, scale: 4 }).notNull(),
  // bigint for consistency with plan money columns, even though the
  // registration fee is small (100_000 satang = 1,000 THB for SweCham).
  registrationFeeMinorUnits: bigint('registration_fee_minor_units', { mode: 'number' })
    .notNull()
    .default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: uuid('updated_by')
    .notNull()
    .references(() => users.id),
});

// --- Inferred row types (Infrastructure → Application translation) ------------

export type MembershipPlanRow = typeof membershipPlans.$inferSelect;
export type MembershipPlanInsert = typeof membershipPlans.$inferInsert;
export type TenantFeeConfigRow = typeof tenantFeeConfig.$inferSelect;
export type TenantFeeConfigInsert = typeof tenantFeeConfig.$inferInsert;
