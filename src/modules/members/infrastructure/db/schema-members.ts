/**
 * F3 Members — Drizzle schema.
 *
 * Single table: `members` (aggregate root; contacts live in a sibling
 * schema file co-located in the same bounded context). See data-model.md § 1.1.
 *
 * **RLS policies, pg_trgm extension, CONCURRENTLY indexes, and the
 * `last_activity_at` denorm trigger are NOT expressed here** — drizzle-kit
 * cannot emit them. They are hand-appended to the generated SQL migration
 * `drizzle/migrations/0008_members_contacts.sql` as raw SQL blocks, mirroring
 * the F2 pattern. See plan.md § Storage + data-model.md § 2 / § 3.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// --- Enums --------------------------------------------------------------------

export const memberStatusEnum = pgEnum('member_status', [
  'active',
  'inactive',
  'archived',
]);

// --- members ------------------------------------------------------------------

export const members = pgTable(
  'members',
  {
    // Tenancy (MTA+STD — F2 pattern, no FK to a tenants table yet)
    tenantId: text('tenant_id').notNull(),

    // Identity — UUID v7 (time-ordered) generated client-side by Domain
    memberId: uuid('member_id').notNull(),

    // Legal entity
    companyName: text('company_name').notNull(),
    legalEntityType: text('legal_entity_type'),
    country: char('country', { length: 2 }).notNull(),
    taxId: text('tax_id'),
    website: text('website'),
    description: text('description'),
    foundedYear: integer('founded_year'),
    // Turnover in THB (integer THB, no decimals — spec Q5 / FR-006).
    // bigint needed because SweCham Premium turnover band goes >100M THB.
    turnoverThb: bigint('turnover_thb', { mode: 'number' }),

    // Plan binding — composite FK to membership_plans (tenant_id, plan_id, plan_year)
    // expressed at the migration layer; Drizzle cannot emit composite FKs from
    // this column-level declaration.
    planId: text('plan_id').notNull(),
    planYear: integer('plan_year').notNull(),

    // Registration
    registrationDate: date('registration_date').notNull().defaultNow(),
    registrationFeePaid: boolean('registration_fee_paid').notNull().default(false),

    // Activity denorm — updated by an AFTER INSERT ON audit_log trigger
    // (see migration 0008). NULL until the first audit event touches this member.
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),

    // Admin-only free text — redacted from member-self GET responses in Application.
    notes: text('notes'),

    // State
    status: memberStatusEnum('status').notNull().default('active'),
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    // Audit metadata
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'members_pkey',
      columns: [table.tenantId, table.memberId],
    }),
    // Directory filter (status + plan). Partial WHERE `archived_at IS NULL`
    // would be nice but status already encodes archive state.
    index('members_tenant_status_plan_idx').on(
      table.tenantId,
      table.status,
      table.planId,
    ),
    // Year filter
    index('members_tenant_year_idx').on(table.tenantId, table.planYear),
    // Directory ORDER BY last_activity_at DESC (E10)
    index('members_tenant_last_activity_idx').on(
      table.tenantId,
      sql`${table.lastActivityAt} DESC NULLS LAST`,
    ),
    // Note: pg_trgm GIN index on company_name is added via raw SQL in the
    // migration (drizzle-kit cannot emit `USING GIN (col gin_trgm_ops)`).
  ],
);

// --- Inferred row types (Infrastructure → Application translation) ------------

export type MemberRow = typeof members.$inferSelect;
export type MemberInsert = typeof members.$inferInsert;
