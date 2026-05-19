/**
 * `PlanRepo` — Drizzle + RLS implementation of the plans port.
 *
 * Every method runs its query inside `runInTenant(tenant, fn)` which
 * sets `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`
 * as the first two statements of the transaction. Postgres RLS then
 * transparently scopes reads + writes to the tenant — there is NO
 * explicit `WHERE tenant_id = ?` in any query here. That's
 * deliberate per research.md § 7.1: adding an explicit filter would
 * imply distrust of the RLS layer, and the whole point of the
 * two-layer defence is that you don't need one.
 *
 * Row → Domain translation lives in `rowToPlan()` below — Drizzle's
 * inferred row type stays in Infrastructure and never leaks into
 * Application per Principle III.
 *
 * Security-critical methods that must be 100% branch covered per
 * vitest.config.ts:
 *   - `cloneYear`     — target-year-populated check + atomicity
 *   - `update`        — secondary locked-field guard (defence in depth)
 *   - `softDelete`    — member-attachment refusal (via Application layer)
 *   - None of the simple CRUD helpers carry branch-level risk by themselves,
 *     but the use-case-level threshold covers them transitively.
 */

import { and, count, eq, ilike, or, sql } from 'drizzle-orm';
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { membershipPlans } from './schema';
import type {
  CloneYearError,
  CloneYearSummary,
  ListPlansFilter,
  PlanDraftInput,
  PlanRepo,
} from '../../application/ports';
import {
  asPlanSlug,
  asPlanYear,
  asTenantSlug,
  type Plan,
  type PlanSlug,
  type PlanYear,
} from '../../domain/plan';
import type { BenefitMatrix, BenefitMatrixLiteral } from '../../domain/benefit-matrix';
import type { LocaleText } from '../../domain/locale-text';
import { detectLockedFieldChanges } from '../../domain/locked-field-rule';

// --- Row → Domain translation -----------------------------------------------

type MembershipPlanRow = typeof membershipPlans.$inferSelect;

/**
 * Clone helpers that shed `readonly` markers + drop `undefined`
 * entries (exactOptionalPropertyTypes is strict). Drizzle's inferred
 * insert shape wants writable structurally-equivalent objects for
 * JSONB columns.
 */
function cloneBenefitMatrix(m: BenefitMatrixLiteral): BenefitMatrix {
  // Post-ship R6 Batch 2a — input is the structural literal; output
  // is the branded BenefitMatrix. DB rows + cloned drafts have
  // already been validated upstream (zod at the API boundary +
  // `asBenefitMatrix` at row→Domain in `rowToPlan` below), so the
  // brand cast is safe at the clone boundary.
  return {
    ...m,
    partnership: m.partnership ? { ...m.partnership } : null,
  } as BenefitMatrix;
}

function cloneLocaleText(t: {
  en: string;
  th?: string | undefined;
  sv?: string | undefined;
}): LocaleText {
  const out: { en: string; th?: string; sv?: string } = { en: t.en };
  if (t.th !== undefined) out.th = t.th;
  if (t.sv !== undefined) out.sv = t.sv;
  return out as LocaleText;
}

function rowToPlan(row: MembershipPlanRow): Plan {
  return {
    tenant_id: asTenantSlug(row.tenantId),
    plan_id: asPlanSlug(row.planId),
    plan_year: asPlanYear(row.planYear),
    plan_name: row.planName as LocaleText,
    description: row.description as LocaleText,
    sort_order: row.sortOrder,
    plan_category: row.planCategory,
    member_type_scope: row.memberTypeScope,
    annual_fee_minor_units: row.annualFeeMinorUnits,
    includes_corporate_plan_id: row.includesCorporatePlanId
      ? asPlanSlug(row.includesCorporatePlanId)
      : null,
    min_turnover_minor_units: row.minTurnoverMinorUnits,
    max_turnover_minor_units: row.maxTurnoverMinorUnits,
    max_duration_years: row.maxDurationYears,
    max_member_age: row.maxMemberAge,
    benefit_matrix: row.benefitMatrix as BenefitMatrix,
    is_active: row.isActive,
    deleted_at: row.deletedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    created_by: row.createdBy,
    updated_by: row.updatedBy,
  };
}

// --- Implementation ---------------------------------------------------------

export const planRepo: PlanRepo = {
  // -- findByTenantAndYear (US1) ---------------------------------------------
  async findByTenantAndYear(tenant, filter: ListPlansFilter) {
    return runInTenant(tenant, async (tx) => {
      const conditions = [];

      if (filter.year !== undefined) {
        conditions.push(eq(membershipPlans.planYear, filter.year));
      }
      if (filter.category !== undefined) {
        conditions.push(eq(membershipPlans.planCategory, filter.category));
      }
      if (filter.activeOnly) {
        conditions.push(eq(membershipPlans.isActive, true));
      }
      if (!filter.showDeleted) {
        conditions.push(sql`${membershipPlans.deletedAt} IS NULL`);
      }
      if (filter.q && filter.q.trim().length > 0) {
        // Free-text search over the EN plan name (primary locale).
        // F3+ will extend to the active locale via a Postgres JSONB path.
        conditions.push(
          or(
            ilike(sql`${membershipPlans.planName}->>'en'`, `%${filter.q}%`),
            ilike(sql`${membershipPlans.planName}->>'th'`, `%${filter.q}%`),
            ilike(sql`${membershipPlans.planName}->>'sv'`, `%${filter.q}%`),
            ilike(membershipPlans.planId, `%${filter.q}%`),
          ),
        );
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const rows = await tx
        .select()
        .from(membershipPlans)
        .where(where)
        .orderBy(sql`${membershipPlans.planCategory} DESC`, membershipPlans.sortOrder);
      return rows.map(rowToPlan);
    });
  },

  // -- findOne (US1 / US3) ---------------------------------------------------
  async findOne(tenant, planId: PlanSlug, year: PlanYear) {
    return runInTenant(tenant, async (tx) => {
      const rows = await tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? rowToPlan(row) : undefined;
    });
  },

  // -- insert (US2 create + seed) --------------------------------------------
  async insert(tenant, draft: PlanDraftInput) {
    return runInTenant(tenant, async (tx) => {
      const row: typeof membershipPlans.$inferInsert = {
        tenantId: tenant.slug,
        planId: draft.plan_id,
        planYear: draft.plan_year,
        // Structurally clone JSONB payloads to shed `readonly` markers
        // + drop `undefined` optional entries (exactOptionalPropertyTypes).
        planName: cloneLocaleText(draft.plan_name),
        description: cloneLocaleText(draft.description),
        sortOrder: draft.sort_order,
        planCategory: draft.plan_category,
        memberTypeScope: draft.member_type_scope,
        annualFeeMinorUnits: draft.annual_fee_minor_units,
        includesCorporatePlanId: draft.includes_corporate_plan_id,
        minTurnoverMinorUnits: draft.min_turnover_minor_units,
        maxTurnoverMinorUnits: draft.max_turnover_minor_units,
        maxDurationYears: draft.max_duration_years,
        maxMemberAge: draft.max_member_age,
        benefitMatrix: cloneBenefitMatrix(draft.benefit_matrix),
        isActive: draft.isActive,
        createdBy: draft.createdBy,
        updatedBy: draft.updatedBy,
      };
      const inserted = await tx
        .insert(membershipPlans)
        .values(row)
        .returning();
      return rowToPlan(inserted[0]!);
    });
  },

  // -- update (US3) ----------------------------------------------------------
  //
  // Defence-in-depth (T117, research.md § 8): re-runs
  // `detectLockedFieldChanges` INSIDE the transaction after loading the
  // row via SELECT. If the guard fires, we roll back the transaction
  // and log a high-severity warning — the Application layer should
  // have blocked the request before reaching here, so a hit means
  // either a race, a bypass bug, or direct repo invocation (from a
  // seed script) that forgot to run the guard. We don't throw — we
  // return `undefined` which the Application layer maps to not_found,
  // because throwing from a repo is a bigger ergonomic hazard.
  async update(tenant, planId, year, patch, updatedBy) {
    return runInTenant(tenant, async (tx) => {
      // Defence-in-depth: SELECT the row before UPDATE to re-verify
      // the lock rule against fresh state. The rule needs the current
      // year; we use the wall clock here because the repo does not
      // receive a ClockPort (that's an Application-layer concern).
      const existingRows = await tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .limit(1);
      const existingRow = existingRows[0];
      if (!existingRow) return undefined;
      const existingPlan = rowToPlan(existingRow);
      const currentYear = new Date().getUTCFullYear();
      const locked = detectLockedFieldChanges(
        existingPlan,
        patch as Partial<Plan>,
        currentYear,
      );
      if (locked.length > 0) {
        logger.warn(
          {
            tenant: tenant.slug,
            planId,
            planYear: year as number,
            lockedFields: locked,
          },
          'plan-repo: defence-in-depth locked-field guard triggered — the Application layer should have blocked this',
        );
        // Abort — return undefined so the caller maps to not_found
        // rather than a misleading success. We do NOT throw here
        // because the Application layer expects `undefined`, not an
        // exception, for defence-in-depth rejections.
        return undefined;
      }

      // Build a sparse update object — only fields present in the patch
      // are written. Drizzle's `.set()` accepts partial records.
      const updateValues: Record<string, unknown> = { updatedBy, updatedAt: new Date() };
      if (patch.plan_name !== undefined) updateValues.planName = patch.plan_name;
      if (patch.description !== undefined) updateValues.description = patch.description;
      if (patch.sort_order !== undefined) updateValues.sortOrder = patch.sort_order;
      if (patch.plan_category !== undefined) updateValues.planCategory = patch.plan_category;
      if (patch.member_type_scope !== undefined)
        updateValues.memberTypeScope = patch.member_type_scope;
      if (patch.annual_fee_minor_units !== undefined)
        updateValues.annualFeeMinorUnits = patch.annual_fee_minor_units;
      if (patch.includes_corporate_plan_id !== undefined)
        updateValues.includesCorporatePlanId = patch.includes_corporate_plan_id;
      if (patch.min_turnover_minor_units !== undefined)
        updateValues.minTurnoverMinorUnits = patch.min_turnover_minor_units;
      if (patch.max_turnover_minor_units !== undefined)
        updateValues.maxTurnoverMinorUnits = patch.max_turnover_minor_units;
      if (patch.max_duration_years !== undefined)
        updateValues.maxDurationYears = patch.max_duration_years;
      if (patch.max_member_age !== undefined)
        updateValues.maxMemberAge = patch.max_member_age;
      if (patch.benefit_matrix !== undefined)
        updateValues.benefitMatrix = patch.benefit_matrix;

      const updated = await tx
        .update(membershipPlans)
        .set(updateValues)
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToPlan(row) : undefined;
    });
  },

  // -- setActive (US4) -------------------------------------------------------
  async setActive(tenant, planId, year, active, updatedBy) {
    return runInTenant(tenant, async (tx) => {
      const updated = await tx
        .update(membershipPlans)
        .set({ isActive: active, updatedBy, updatedAt: new Date() })
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToPlan(row) : undefined;
    });
  },

  // -- softDelete (US4) ------------------------------------------------------
  async softDelete(tenant, planId, year, deletedAt, updatedBy) {
    return runInTenant(tenant, async (tx) => {
      const updated = await tx
        .update(membershipPlans)
        .set({ deletedAt, updatedBy, updatedAt: new Date() })
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToPlan(row) : undefined;
    });
  },

  // -- undelete (US4) --------------------------------------------------------
  async undelete(tenant, planId, year, updatedBy) {
    return runInTenant(tenant, async (tx) => {
      const updated = await tx
        .update(membershipPlans)
        .set({
          deletedAt: null,
          // US4 AS4: undelete returns plans to inactive, never directly active
          isActive: false,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(membershipPlans.planId, planId),
            eq(membershipPlans.planYear, year),
          ),
        )
        .returning();
      const row = updated[0];
      return row ? rowToPlan(row) : undefined;
    });
  },

  // -- cloneYear (US2) -------------------------------------------------------
  //
  // Concurrency guard (post-ship R6 I3, 2026-05-19): per-(tenant,
  // targetYear) advisory lock at the start of the transaction. Two
  // concurrent clones into the same (tenant, year) would otherwise race
  // past the `count > 0` check below — the second caller's bulk INSERT
  // would then trip the membership_plans_pkey unique constraint and
  // roll back, but the lock guarantees the second caller blocks until
  // the first commits and re-reads the populated count → returns
  // `target_year_populated` cleanly. Namespace `plans:clone:` is
  // disjoint from F4 `invoicing:` / F5 `payments:` / F7 `broadcasts:`
  // / F8 `renewals:`. Released automatically when the tx commits or
  // rolls back (`pg_advisory_xact_lock`).
  async cloneYear(tenant, sourceYear, targetYear, activateCloned, createdBy) {
    return runInTenant(tenant, async (tx): Promise<Result<CloneYearSummary, CloneYearError>> => {
      const lockKey = `plans:clone:${tenant.slug}:${targetYear as number}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );

      // 1. Refuse if target year already populated
      const targetRows = await tx
        .select({ count: count() })
        .from(membershipPlans)
        .where(eq(membershipPlans.planYear, targetYear));
      const existingCount = Number(targetRows[0]?.count ?? 0);
      if (existingCount > 0) {
        return err({ type: 'target_year_populated', existingCount });
      }

      // 2. Load source plans (excluding soft-deleted)
      const sources = await tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.planYear, sourceYear),
            sql`${membershipPlans.deletedAt} IS NULL`,
          ),
        );
      if (sources.length === 0) {
        return err({ type: 'source_year_empty' });
      }

      // 3. Bulk insert into target year
      const now = new Date();
      const values = sources.map((row) => ({
        tenantId: row.tenantId, // RLS re-verifies this matches current_tenant
        planId: row.planId,
        planYear: targetYear,
        planName: row.planName,
        description: row.description,
        sortOrder: row.sortOrder,
        planCategory: row.planCategory,
        memberTypeScope: row.memberTypeScope,
        annualFeeMinorUnits: row.annualFeeMinorUnits,
        includesCorporatePlanId: row.includesCorporatePlanId,
        minTurnoverMinorUnits: row.minTurnoverMinorUnits,
        maxTurnoverMinorUnits: row.maxTurnoverMinorUnits,
        maxDurationYears: row.maxDurationYears,
        maxMemberAge: row.maxMemberAge,
        benefitMatrix: row.benefitMatrix,
        isActive: activateCloned,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        createdBy,
        updatedBy: createdBy,
      }));
      const inserted = await tx
        .insert(membershipPlans)
        .values(values)
        .returning({ planId: membershipPlans.planId });

      return ok({
        sourceYear,
        targetYear,
        clonedPlanIds: inserted.map((r) => asPlanSlug(r.planId)),
        count: inserted.length,
      });
    });
  },

  // NOTE: `countActiveForTenant` was retired in R7/R8 consolidation —
  // it backed the fee-config currency immutability guard (T145), which
  // is no longer needed since `tenant_fee_config` was dropped by
  // migration 0029. Removed 2026-05-19 (post-ship R6 C5).
};

