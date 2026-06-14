/**
 * Pre-seed the NEXT fiscal year's `membership_plans` catalogue for a
 * tenant by CLONING the current year's ACTIVE plans — data-readiness
 * item from the #59 tax review.
 *
 * ## Why this exists
 *
 * A renewal cycle whose `period_from` lands in fiscal year Y+1 derives
 * its `plan_year = deriveFiscalYear(period_from) = Y+1`. When that cycle
 * is billed, `createInvoiceDraft` calls `getAnnualFeeSatang(tenant,
 * plan_id, Y+1)` and the issued tax invoice carries an
 * `invoices_plan_fk` (migration 0019) onto
 * `membership_plans(tenant_id, plan_id, plan_year)`. If no `(tenant,
 * plan_id, Y+1)` catalogue row exists, the draft fails `plan_not_found`
 * and the §86/4 "Membership {year}" label has no anchor row. This script
 * pre-seeds those Y+1 rows so a next-year renewal can bill cleanly.
 *
 * ## CRITICAL correctness — clone as `is_active = FALSE`
 *
 * The cloned next-year rows MUST be `is_active = false`. Two readers
 * resolve plans on DIFFERENT keys, and the inactive flag threads the
 * needle between them:
 *
 *   - `loadPlanFrozenFields`
 *     (`src/modules/renewals/infrastructure/ports-adapters/
 *      plan-lookup-for-renewal-drizzle.ts`) is now EXACT-YEAR-FIRST (070
 *     code-review): a cycle freezes the row for its OWN fiscal year, so
 *     activating Y+1 early no longer corrupts a current cycle. Cloning Y+1
 *     as inactive is STILL required because nothing in the DB enforces a
 *     single active `plan_year` per plan — keeping Y+1 inactive avoids an
 *     ambiguous two-active-year catalogue + a premature offering before the
 *     fiscal year opens. Admin flips them active via /admin/plans when Y+1
 *     opens. ✓
 *
 *   - `getAnnualFeeSatang`
 *     (`src/modules/invoicing/infrastructure/adapters/
 *      plan-lookup-adapter.ts`) keys on the EXACT
 *     `(tenant_id, plan_id, plan_year)` with NO active filter — it WILL
 *     find the inactive Y+1 row, satisfying the FK + label when a
 *     next-year cycle actually bills. ✓
 *
 * The chamber admin flips the Y+1 plans active when that year actually
 * opens (a UI action — out of scope here).
 *
 * ## Behaviour
 *
 *   - Source = the tenant's SOURCE_YEAR plans that are
 *     `is_active = true AND deleted_at IS NULL`.
 *   - Target year = TARGET_YEAR (default SOURCE_YEAR + 1).
 *   - Clones EVERY catalogue column faithfully (see `CLONED_COLUMNS`
 *     below) — same prices ("ใช้ของเดิม"), same benefit matrix, same
 *     tier bucket — to a new row with `plan_year = TARGET_YEAR`,
 *     `is_active = false`, `deleted_at = NULL`, fresh timestamps, and
 *     `created_by`/`updated_by` = the seed admin.
 *   - Idempotent: if the tenant already has ANY row for TARGET_YEAR
 *     (incl. soft-deleted), it skips with "already seeded" and never
 *     double-inserts.
 *   - Emits one `plan_created` audit event per cloned plan, all sharing
 *     a single correlation `requestId` per run (mirrors
 *     `seed-swecham-2026-plans.ts` stage B).
 *   - DRY-RUN by default (reports exactly which plans WOULD be cloned +
 *     the target year + counts, mutates nothing); `--apply` performs the
 *     inserts + audits.
 *
 * ## Why `runInTenant` (not the cross-tenant bare `db`)
 *
 * This is a strictly PER-TENANT operation keyed on `TENANT_SLUG`, the
 * same shape as `seed-swecham-2026-plans.ts` (which also uses
 * `runInTenant`). Threading `runInTenant(ctx, ...)` activates RLS
 * (`SET LOCAL app.current_tenant`), so even a logic bug cannot read or
 * write another tenant's catalogue — defence in depth that the
 * cross-tenant `db` owner pattern (used by `clear-test-data.ts` /
 * `check-stray-plan-years.ts` for whole-catalogue scans) deliberately
 * forgoes. We never enumerate other tenants here, so we want RLS ON.
 *
 * ## Usage
 *
 *   # dry-run (reports, mutates nothing)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/clone-plans-to-next-year.ts
 *
 *   # apply (inserts inactive Y+1 rows + audit events)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/clone-plans-to-next-year.ts --apply
 *
 * Overrides (env): SOURCE_YEAR (default = current UTC year),
 * TARGET_YEAR (default = SOURCE_YEAR + 1). TARGET_YEAR must equal
 * SOURCE_YEAR + 1 unless ALLOW_YEAR_GAP=1 is set (refuses an
 * implausible multi-year gap to catch operator typos).
 *
 * Exit codes:
 *   0 — cloned (or already seeded / dry-run report)
 *   1 — validation failed OR infrastructure error
 */
process.loadEnvFile?.('.env.local');

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db, runInTenant } from '@/lib/db';
import {
  asTenantContext,
  TENANT_SLUG_PATTERN,
  type TenantContext,
} from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';

// ---------------------------------------------------------------------------
// Cloned-column manifest — kept as a comment so a schema drift review can
// diff this list against `membershipPlans` in
// `src/modules/plans/infrastructure/db/schema.ts`. Every catalogue column
// of `membership_plans` is accounted for here:
//
//   IDENTITY / TENANCY
//     tenant_id               — same tenant (RLS re-verifies)
//     plan_id                 — same
//     plan_year               — CHANGED to TARGET_YEAR
//   DISPLAY
//     plan_name (jsonb)       — copied
//     description (jsonb)     — copied
//     sort_order              — copied
//   CLASSIFICATION
//     plan_category           — copied
//     member_type_scope       — copied
//   PRICING ("ใช้ของเดิม" — same fees)
//     annual_fee_minor_units  — copied
//   BUNDLING
//     includes_corporate_plan_id — copied
//   ELIGIBILITY
//     min_turnover_minor_units   — copied
//     max_turnover_minor_units   — copied
//     max_duration_years         — copied
//     max_member_age             — copied
//   BENEFITS
//     benefit_matrix (jsonb)  — copied
//   F8 TIER BUCKET
//     renewal_tier_bucket     — copied (NOTE: F2's `planRepo.insert` /
//                               `cloneYear` do NOT carry this column, so
//                               this script does a faithful RAW insert
//                               rather than reuse the repo — otherwise
//                               the clone would silently reset the bucket
//                               to its 'regular' default.)
//   STATE
//     is_active               — FORCED to FALSE (see header rationale)
//     deleted_at              — FORCED to NULL
//     created_at / updated_at — fresh `now`
//     created_by / updated_by — seed admin
// ---------------------------------------------------------------------------

/** A source plan row reduced to the columns we clone (+ display name). */
export interface SourcePlanRow {
  readonly planId: string;
  readonly planYear: number;
  readonly planNameEn: string;
  readonly planCategory: 'corporate' | 'partnership';
  readonly memberTypeScope: 'company' | 'individual' | 'both';
  readonly annualFeeMinorUnits: number;
  readonly renewalTierBucket: string;
}

export interface ClonePlansReport {
  readonly tenantSlug: string;
  readonly sourceYear: number;
  readonly targetYear: number;
  readonly apply: boolean;
  /** True when TARGET_YEAR already had ≥1 row (incl. soft-deleted). */
  readonly skippedAlreadySeeded: boolean;
  /** Source-year active plans that WOULD be / WERE cloned. */
  readonly candidates: readonly SourcePlanRow[];
  /** Plans actually inserted (`--apply` only; empty in dry-run/skip). */
  readonly cloned: readonly SourcePlanRow[];
}

/** Number of months in a fiscal year — the only sane SOURCE→TARGET gap. */
const REQUIRED_YEAR_GAP = 1;

export class CloneYearGapError extends Error {
  constructor(sourceYear: number, targetYear: number) {
    super(
      `clone-plans-to-next-year: TARGET_YEAR (${targetYear}) must equal ` +
        `SOURCE_YEAR + ${REQUIRED_YEAR_GAP} (${sourceYear + REQUIRED_YEAR_GAP}). ` +
        `Set ALLOW_YEAR_GAP=1 to override (only do this if you truly mean ` +
        `to seed a non-adjacent year).`,
    );
    this.name = 'CloneYearGapError';
  }
}

/**
 * Resolve + validate the source/target years from explicit options or
 * the environment. Exported pure so the test can assert the gap guard
 * without spinning the DB.
 *
 *   - sourceYear default = current UTC calendar year.
 *   - targetYear default = sourceYear + 1.
 *   - Refuses targetYear !== sourceYear + 1 unless `allowGap` is true.
 */
export function resolveYears(opts?: {
  readonly sourceYear?: number;
  readonly targetYear?: number;
  readonly allowGap?: boolean;
}): { readonly sourceYear: number; readonly targetYear: number } {
  const sourceYear =
    opts?.sourceYear ??
    (process.env.SOURCE_YEAR
      ? Number(process.env.SOURCE_YEAR)
      : new Date().getUTCFullYear());
  const targetYear =
    opts?.targetYear ??
    (process.env.TARGET_YEAR
      ? Number(process.env.TARGET_YEAR)
      : sourceYear + REQUIRED_YEAR_GAP);

  if (!Number.isInteger(sourceYear) || !Number.isInteger(targetYear)) {
    throw new Error(
      `clone-plans-to-next-year: SOURCE_YEAR/TARGET_YEAR must be integers ` +
        `(got source=${String(sourceYear)} target=${String(targetYear)}).`,
    );
  }

  const allowGap =
    opts?.allowGap ?? process.env.ALLOW_YEAR_GAP === '1';
  if (!allowGap && targetYear !== sourceYear + REQUIRED_YEAR_GAP) {
    throw new CloneYearGapError(sourceYear, targetYear);
  }
  return { sourceYear, targetYear };
}

/**
 * Resolve the `created_by`/`updated_by` admin user id + the audit actor.
 * Prefers BOOTSTRAP_ADMIN_EMAIL, else the first admin account. Mirrors
 * `seed-swecham-2026-plans.ts:findSeedOwnerUserId`.
 *
 * Runs as the bare `db` owner role (NOT `runInTenant`) because `users`
 * is a tenant-less F1 identity table — there is no tenant column to scope
 * by, and the bootstrap admin is the cross-tenant operator account.
 */
export async function findSeedOwnerUserId(): Promise<string> {
  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.toLowerCase();
  const rows = bootstrapEmail
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(eq(sql`lower(${users.email})`, bootstrapEmail))
        .limit(1)
    : await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.role, 'admin'))
        .limit(1);

  const id = rows[0]?.id;
  if (!id) {
    throw new Error(
      'clone-plans-to-next-year: no admin user found. Run `pnpm db:seed-admin` first, ' +
        'or set BOOTSTRAP_ADMIN_EMAIL.',
    );
  }
  return id;
}

/**
 * Require + validate the TENANT_SLUG env. Accepts any slug matching the
 * tenant pattern; refuses an empty/malformed value so the operator can
 * never accidentally run against an unintended namespace.
 */
export function requireTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug.length === 0) {
    throw new Error(
      'clone-plans-to-next-year: TENANT_SLUG env is required (e.g. TENANT_SLUG=swecham).',
    );
  }
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `clone-plans-to-next-year: refusing to run against malformed ` +
        `TENANT_SLUG="${slug}" (must match [a-z0-9-]{1,63}).`,
    );
  }
  return asTenantContext(slug);
}

/**
 * Core routine. Exported pure-ish so an integration test can drive it
 * against a throwaway tenant.
 *
 * @param ctx          tenant context (RLS scope)
 * @param ownerUserId  admin uuid for created_by/updated_by + audit actor
 * @param opts         sourceYear / targetYear / apply
 */
export async function clonePlansToNextYear(
  ctx: TenantContext,
  ownerUserId: string,
  opts: {
    readonly sourceYear: number;
    readonly targetYear: number;
    readonly apply: boolean;
  },
): Promise<ClonePlansReport> {
  const { sourceYear, targetYear, apply } = opts;

  return runInTenant(ctx, async (tx) => {
    // 1. Idempotency guard — ANY row for TARGET_YEAR (incl. soft-deleted)
    //    means the year is already seeded. We DO NOT filter `deleted_at`
    //    here on purpose: a soft-deleted Y+1 row still occupies the
    //    (tenant, plan_id, plan_year) PK, so a re-insert would collide.
    //    Reporting "already seeded" is the safe, honest outcome.
    const existing = await tx
      .select({ planId: membershipPlans.planId })
      .from(membershipPlans)
      .where(eq(membershipPlans.planYear, targetYear))
      .limit(1);

    // 2. Read source-year ACTIVE catalogue (skip soft-deleted + inactive).
    //    Full rows — we copy every catalogue column on insert below.
    const sources = await tx
      .select()
      .from(membershipPlans)
      .where(
        and(
          eq(membershipPlans.planYear, sourceYear),
          eq(membershipPlans.isActive, true),
          isNull(membershipPlans.deletedAt),
        ),
      )
      .orderBy(membershipPlans.sortOrder, desc(membershipPlans.planId));

    const candidates: SourcePlanRow[] = sources.map((row) => ({
      planId: row.planId,
      planYear: row.planYear,
      planNameEn:
        (row.planName as { en?: string } | null)?.en ?? '(no en name)',
      planCategory: row.planCategory,
      memberTypeScope: row.memberTypeScope,
      annualFeeMinorUnits: row.annualFeeMinorUnits,
      renewalTierBucket: row.renewalTierBucket,
    }));

    const baseReport = {
      tenantSlug: ctx.slug,
      sourceYear,
      targetYear,
      apply,
      candidates,
    } as const;

    // Already seeded → never double-insert.
    if (existing.length > 0) {
      return {
        ...baseReport,
        skippedAlreadySeeded: true,
        cloned: [],
      };
    }

    // Dry-run → report candidates, mutate nothing.
    if (!apply) {
      return {
        ...baseReport,
        skippedAlreadySeeded: false,
        cloned: [],
      };
    }

    // 3. Apply — faithful raw insert of EVERY catalogue column with
    //    plan_year → TARGET_YEAR, is_active → false, deleted_at → null.
    //    Done inside this SAME tx so the whole clone is atomic: either
    //    all Y+1 rows land or none do (a partial clone can't strand the
    //    catalogue). RAW insert (not `planRepo.insert`) so the
    //    `renewal_tier_bucket` column is carried — the F2 repo drops it.
    const now = new Date();
    const insertValues: (typeof membershipPlans.$inferInsert)[] = sources.map(
      (row) => ({
        tenantId: ctx.slug, // RLS WITH CHECK re-verifies == current_tenant
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
        renewalTierBucket: row.renewalTierBucket,
        isActive: false, // CRITICAL — see header rationale
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        createdBy: ownerUserId,
        updatedBy: ownerUserId,
      }),
    );

    if (insertValues.length > 0) {
      await tx.insert(membershipPlans).values(insertValues);
    }

    return {
      ...baseReport,
      skippedAlreadySeeded: false,
      cloned: candidates,
    };
  });
}

/**
 * Emit one `plan_created` audit event per cloned plan, all sharing a
 * single correlation `requestId` (`clone-plans-${runUUID}`) so a
 * forensic query can stitch the run together as one unit of work.
 *
 * Runs AFTER `clonePlansToNextYear` commits its inserts. A failed audit
 * write throws with the failing plan_id so the operator can investigate;
 * the plan rows are already committed (consistent with
 * `seed-swecham-2026-plans.ts` stage B's per-row audit-after-insert
 * contract).
 */
export async function emitCloneAudits(
  ctx: TenantContext,
  ownerUserId: string,
  cloned: readonly SourcePlanRow[],
  targetYear: number,
): Promise<void> {
  if (cloned.length === 0) return;
  const runUUID = randomUUID();
  for (const plan of cloned) {
    const result = await planAuditAdapter.record(
      {
        tenant: ctx,
        actorUserId: ownerUserId,
        requestId: `clone-plans-${runUUID}`,
        sourceIp: null,
      },
      {
        event_type: 'plan_created',
        payload: {
          plan_id: plan.planId,
          plan_year: targetYear,
          plan_name_en: plan.planNameEn,
          annual_fee_minor_units: plan.annualFeeMinorUnits,
          category: plan.planCategory,
          member_type_scope: plan.memberTypeScope,
        },
      },
    );
    if (!result.ok) {
      throw new Error(
        `[clone-plans] plan_created audit failed for ${plan.planId}@${targetYear} ` +
          `(plan rows already committed): ${JSON.stringify(result.error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const ctx = requireTenant();
  const { sourceYear, targetYear } = resolveYears();

  console.log('');
  console.log('=== clone-plans-to-next-year ===');
  console.log(`Tenant:      ${ctx.slug}`);
  console.log(`Source year: ${sourceYear} (active, non-deleted plans)`);
  console.log(`Target year: ${targetYear} (cloned as is_active = FALSE)`);
  console.log(
    `Mode:        ${apply ? 'APPLY (inserts rows + audits)' : 'DRY-RUN (report only)'}`,
  );

  const ownerUserId = await findSeedOwnerUserId();
  console.log(`Owner user:  ${ownerUserId}`);
  console.log('');

  const report = await clonePlansToNextYear(ctx, ownerUserId, {
    sourceYear,
    targetYear,
    apply,
  });

  if (report.skippedAlreadySeeded) {
    console.log(
      `ALREADY SEEDED — tenant "${ctx.slug}" already has ≥1 row for ` +
        `plan_year ${targetYear}. No rows inserted (idempotent skip).`,
    );
    console.log('');
    console.log('clone-plans-to-next-year: done');
    return;
  }

  if (report.candidates.length === 0) {
    console.log(
      `No active source plans found for plan_year ${sourceYear}. Nothing to clone.`,
    );
    console.log('');
    console.log('clone-plans-to-next-year: done');
    return;
  }

  console.log(
    `${apply ? 'Cloning' : 'Would clone'} ${report.candidates.length} ` +
      `plan(s) from ${sourceYear} → ${targetYear} (as is_active = FALSE):`,
  );
  for (const plan of report.candidates) {
    console.log(
      `    plan_id=${plan.planId} category=${plan.planCategory} ` +
        `tier=${plan.renewalTierBucket} fee=${plan.annualFeeMinorUnits} ` +
        `name="${plan.planNameEn}"`,
    );
  }
  console.log('');

  if (!apply) {
    console.log(
      `DRY-RUN — would clone ${report.candidates.length} plan(s). ` +
        `Re-run with --apply to insert the inactive ${targetYear} catalogue.`,
    );
    console.log('');
    console.log('clone-plans-to-next-year: done');
    return;
  }

  // Audit AFTER the insert tx committed.
  await emitCloneAudits(ctx, ownerUserId, report.cloned, targetYear);

  console.log(
    `CLONED ${report.cloned.length} plan(s) into plan_year ${targetYear} ` +
      `(is_active = FALSE) + emitted ${report.cloned.length} plan_created audit event(s).`,
  );
  console.log(
    `Next step: a chamber admin flips the ${targetYear} plans active via the ` +
      `admin UI when that fiscal year opens.`,
  );
  console.log('');
  console.log('clone-plans-to-next-year: done');
}

// Only auto-run when invoked directly, not when imported by the test.
const invokedDirectly =
  (process.argv[1] !== undefined &&
    process.argv[1] === fileURLToPath(import.meta.url)) ||
  process.argv[1]?.endsWith('clone-plans-to-next-year.ts') === true ||
  process.argv[1]?.endsWith('clone-plans-to-next-year.js') === true;

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(
        'clone-plans-to-next-year FAILED:',
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
