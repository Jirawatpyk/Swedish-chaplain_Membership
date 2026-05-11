/**
 * F8 Phase 2 Wave C · T022 — Drizzle schema for `tier_upgrade_suggestions`.
 *
 * Pairs with migration `drizzle/migrations/0091_f8_create_tier_upgrade_suggestions_table.sql`.
 * Source of truth: data-model.md § 2.6.
 */
import {
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { members } from '@/modules/members/infrastructure/db/schema-members';

/**
 * Evidence payload stored in `evidence_jsonb`. Concrete shape lives in
 * the Domain layer (Wave D T035); this is the structural footprint for
 * adapter-side typed reads.
 */
export interface TierUpgradeEvidenceJson {
  readonly turnover_thb?: number;
  readonly invoice_volume_thb?: number;
  readonly threshold_met_at?: string;
  readonly [key: string]: unknown;
}

export const tierUpgradeSuggestions = pgTable(
  'tier_upgrade_suggestions',
  {
    tenantId: text('tenant_id').notNull(),
    suggestionId: uuid('suggestion_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    memberId: uuid('member_id').notNull(),
    // F8 Phase 7 fix (migration 0117): plan_id columns are TEXT (slug
    // identifiers like 'regular', 'premium'), not UUID. The original
    // migration 0091 typed these as `uuid` but F2 catalogue uses slugs.
    fromPlanId: text('from_plan_id').notNull(),
    toPlanId: text('to_plan_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    evidenceJsonb: jsonb('evidence_jsonb')
      .$type<TierUpgradeEvidenceJson>()
      .notNull(),
    // 6-state machine.
    status: text('status').notNull().default('open'),
    suppressedUntil: timestamp('suppressed_until', { withTimezone: true }),
    dismissedReason: text('dismissed_reason'),

    // Pending-application fields (Q5 round 2).
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id'),
    targetApplyAtCycleId: uuid('target_apply_at_cycle_id'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedAtInvoiceId: uuid('applied_at_invoice_id'),
    memberNotifiedAt: timestamp('member_notified_at', { withTimezone: true }),
    adminVerificationTaskId: uuid('admin_verification_task_id'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({
      name: 'tier_upgrade_suggestions_pk',
      columns: [table.tenantId, table.suggestionId],
    }),
    memberFk: foreignKey({
      name: 'tier_upgrade_suggestions_member_fk',
      columns: [table.tenantId, table.memberId],
      foreignColumns: [members.tenantId, members.memberId],
    }).onDelete('cascade'),
    // At most one open OR pending-apply suggestion per member.
    memberOpenUniq: uniqueIndex('tier_upgrade_suggestions_member_open_uniq')
      .on(table.tenantId, table.memberId)
      .where(sql`status IN ('open','accepted_pending_apply')`),
    suppressedIdx: index('tier_upgrade_suggestions_suppressed_idx')
      .on(table.tenantId, table.status, table.suppressedUntil)
      .where(sql`status = 'dismissed'`),
    // Round 6 S-008 — composite + partial for the per-member
    // `isSuppressedForMember` query path. The original suppressed_idx
    // (tenant + status + suppressed_until) lacked `member_id` in the
    // leading columns, forcing a heap-filter at scale. Migration 0123
    // ships the SQL.
    memberSuppressedIdx: index(
      'tier_upgrade_suggestions_member_suppressed_idx',
    )
      .on(table.tenantId, table.memberId, table.suppressedUntil)
      .where(sql`status = 'dismissed'`),
    pendingApplyIdx: index('tier_upgrade_suggestions_pending_apply_idx')
      .on(table.tenantId, table.targetApplyAtCycleId)
      .where(sql`status = 'accepted_pending_apply'`),
  }),
);

export type TierUpgradeSuggestionRow =
  typeof tierUpgradeSuggestions.$inferSelect;
export type TierUpgradeSuggestionInsert =
  typeof tierUpgradeSuggestions.$inferInsert;
