/**
 * Round-3 — seed the SweCham plan_year-2024 catalogue (Part 3 of the
 * Round-3 import; docs/import/ROUND3_PLAN.md § wipe → seed 2024 plans).
 *
 * WHY: 19 inactive Round-3 members carry 2024 registration anchors, so the
 * member import writes `members.plan_year = 2024` and the composite FK
 * `members_plan_tenant_year_fk (tenant_id, plan_id, plan_year)` needs a
 * catalogue row for EVERY 2024 plan_id.
 *
 * The 2024 rows are ALSO load-bearing for any 2024-ISSUED document the sheet
 * produces: a bill whose Inv Date falls in calendar 2024 inserts
 * `invoices.plan_year = 2024` (SC-2024 stream; `invoices_plan_fk` RESTRICT),
 * and its renewal cycle would freeze plan price against the FY2024 catalogue
 * (plan-lookup-for-renewal resolves the exact-year row in 'freeze' mode
 * REGARDLESS of `is_active` — only 'offer' mode filters on it; neither FK
 * checks activity). Cloning `is_active = false` is therefore safe AND keeps
 * 2024 out of every offer surface (mirrors the clone-plans-to-next-year.ts
 * rationale). Measured against the v2 workbook 2026-07-29: all 125 selected
 * invoice docs land in 2025/2026, so today only the members FK actually
 * references 2024 — but the bill/freeze paths above are what make this seed
 * remain correct if a sheet correction ever moves an Inv Date into 2024.
 * 2025 + 2026 are ALREADY seeded in prod — this script never touches them
 * (hard-pinned source/target years).
 *
 * Behaviour (per-plan_id idempotent — unlike seed-swecham-2026-plans.ts's
 * all-or-nothing stage B):
 *   - Source = ALL non-deleted (swecham, 2026) rows — the 9-plan catalogue.
 *   - Skips any plan_id that already has a 2024 row (incl. soft-deleted —
 *     the PK is occupied either way); creates only the missing ones.
 *   - Faithful RAW insert of every catalogue column incl.
 *     `renewal_tier_bucket` (the F2 repo drops it — see
 *     clone-plans-to-next-year.ts CLONED_COLUMNS note), with
 *     `is_active = false`, `deleted_at = NULL`, fresh timestamps,
 *     created_by/updated_by = the seed admin.
 *   - Emits one `plan_created` audit event per inserted plan AFTER the
 *     insert tx commits, all sharing requestId `seed-2024-plans-<uuid>`.
 *   - DRY-RUN by default; `--apply` inserts.
 *
 * Guards: TENANT_SLUG must equal 'swecham' (seed-swecham-2026-plans.ts
 * convention); an admin user must exist for created_by (BOOTSTRAP_ADMIN_EMAIL
 * override supported).
 *
 *   # dry-run
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/seed-2024-plans-swecham.ts
 *
 *   # apply (prod: --env-file=.env.production per the run-scripts runbook)
 *   TENANT_SLUG=swecham \
 *     node --env-file=.env.local --import tsx scripts/seed-2024-plans-swecham.ts --apply
 *
 * Exit codes: 0 — seeded / already seeded / dry-run; 1 — validation or
 * infrastructure error.
 */
process.loadEnvFile?.('.env.local');

import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';

const SOURCE_YEAR = 2026;
const TARGET_YEAR = 2024;

export interface Seed2024Report {
  readonly apply: boolean;
  /** plan_ids inserted (or that WOULD be inserted in dry-run). */
  readonly created: readonly string[];
  /** plan_ids skipped because a 2024 row already exists. */
  readonly skipped: readonly string[];
}

function requireSwechamTenant(): TenantContext {
  const slug = process.env.TENANT_SLUG ?? '';
  if (slug !== 'swecham') {
    throw new Error(
      `seed-2024-plans-swecham: refusing to run against TENANT_SLUG="${slug}". ` +
        `Only 'swecham' is allowed.`,
    );
  }
  return asTenantContext('swecham');
}

/** Mirrors seed-swecham-2026-plans.ts:findSeedOwnerUserId. */
async function findSeedOwnerUserId(): Promise<string> {
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
      'seed-2024-plans-swecham: no admin user found. Run `pnpm db:seed-admin` first, ' +
        'or set BOOTSTRAP_ADMIN_EMAIL.',
    );
  }
  return id;
}

/**
 * Core routine — exported so an integration/one-off check can drive it
 * against a throwaway tenant. Insert happens in ONE runInTenant tx.
 */
export async function seed2024Plans(
  ctx: TenantContext,
  ownerUserId: string,
  opts: { readonly apply: boolean },
): Promise<Seed2024Report> {
  return runInTenant(ctx, async (tx) => {
    const sources = await tx
      .select()
      .from(membershipPlans)
      .where(
        and(
          eq(membershipPlans.planYear, SOURCE_YEAR),
          isNull(membershipPlans.deletedAt),
        ),
      )
      .orderBy(membershipPlans.sortOrder, membershipPlans.planId);

    if (sources.length === 0) {
      throw new Error(
        `seed-2024-plans-swecham: no ${SOURCE_YEAR} catalogue found for ` +
          `"${ctx.slug}" — run scripts/seed-swecham-2026-plans.ts first.`,
      );
    }

    // Per-plan_id idempotency: a 2024 row (even soft-deleted) occupies the
    // (tenant, plan_id, plan_year) PK → skip that plan_id, create the rest.
    const existing = await tx
      .select({ planId: membershipPlans.planId })
      .from(membershipPlans)
      .where(eq(membershipPlans.planYear, TARGET_YEAR));
    const existingIds = new Set(existing.map((r) => r.planId));

    const toCreate = sources.filter((row) => !existingIds.has(row.planId));
    const created = toCreate.map((row) => row.planId);
    const skipped = sources
      .filter((row) => existingIds.has(row.planId))
      .map((row) => row.planId);

    if (opts.apply && toCreate.length > 0) {
      const now = new Date();
      await tx.insert(membershipPlans).values(
        toCreate.map((row) => ({
          tenantId: ctx.slug, // RLS WITH CHECK re-verifies == current_tenant
          planId: row.planId,
          planYear: TARGET_YEAR,
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
          isActive: false, // FK-anchor only — never offered (see header)
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
          createdBy: ownerUserId,
          updatedBy: ownerUserId,
        })),
      );
    }

    return { apply: opts.apply, created, skipped };
  });
}

/**
 * One `plan_created` audit event per inserted plan (after the insert tx
 * commits) — mirrors clone-plans-to-next-year.ts:emitCloneAudits.
 */
async function emitSeedAudits(
  ctx: TenantContext,
  ownerUserId: string,
  createdPlanIds: readonly string[],
): Promise<void> {
  if (createdPlanIds.length === 0) return;
  const runUUID = randomUUID();
  // Re-read the freshly inserted rows for honest payloads.
  const rows = await runInTenant(ctx, (tx) =>
    tx
      .select()
      .from(membershipPlans)
      .where(eq(membershipPlans.planYear, TARGET_YEAR)),
  );
  const byId = new Map(rows.map((r) => [r.planId, r]));
  for (const planId of createdPlanIds) {
    const row = byId.get(planId);
    if (!row) continue;
    const result = await planAuditAdapter.record(
      {
        tenant: ctx,
        actorUserId: ownerUserId,
        requestId: `seed-2024-plans-${runUUID}`,
        sourceIp: null,
      },
      {
        event_type: 'plan_created',
        payload: {
          plan_id: row.planId,
          plan_year: row.planYear,
          plan_name_en: (row.planName as { en?: string } | null)?.en ?? '',
          annual_fee_minor_units: row.annualFeeMinorUnits,
          category: row.planCategory,
          member_type_scope: row.memberTypeScope,
        },
      },
    );
    if (!result.ok) {
      throw new Error(
        `[seed-2024-plans] plan_created audit failed for ${planId}@${TARGET_YEAR} ` +
          `(plan rows already committed): ${JSON.stringify(result.error)}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const ctx = requireSwechamTenant();
  console.log('');
  console.log('=== seed-2024-plans-swecham ===');
  console.log(`Tenant:      ${ctx.slug}`);
  console.log(`Source year: ${SOURCE_YEAR} (non-deleted catalogue)`);
  console.log(`Target year: ${TARGET_YEAR} (cloned as is_active = FALSE — FK anchor only)`);
  console.log(`Mode:        ${apply ? 'APPLY (inserts + audits)' : 'DRY-RUN (report only)'}`);

  const ownerUserId = await findSeedOwnerUserId();
  console.log(`Owner user:  ${ownerUserId}`);

  const report = await seed2024Plans(ctx, ownerUserId, { apply });

  console.log('');
  console.log(
    `${apply ? 'Created' : 'Would create'} ${report.created.length} plan(s): ` +
      (report.created.length > 0 ? report.created.join(', ') : '(none)'),
  );
  console.log(
    `Skipped ${report.skipped.length} plan(s) already present for ${TARGET_YEAR}: ` +
      (report.skipped.length > 0 ? report.skipped.join(', ') : '(none)'),
  );

  if (apply) {
    await emitSeedAudits(ctx, ownerUserId, report.created);
    if (report.created.length > 0) {
      console.log(`Emitted ${report.created.length} plan_created audit event(s).`);
    }
  } else if (report.created.length > 0) {
    console.log('Re-run with --apply to insert.');
  }
  console.log('');
  console.log('seed-2024-plans-swecham: done');
}

// Only run when invoked directly (not when imported by a test).
if (process.argv[1] && process.argv[1].endsWith('seed-2024-plans-swecham.ts')) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(
        'seed-2024-plans-swecham FAILED:',
        e instanceof Error ? e.message : String(e),
      );
      process.exit(1);
    });
}
