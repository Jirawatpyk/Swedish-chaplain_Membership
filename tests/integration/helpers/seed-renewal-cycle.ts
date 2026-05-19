/**
 * R2 Batch 3b-bis — shared `seedMemberAndRenewalCycle` helper.
 *
 * Migration 0125 added `scheduled_plan_changes_effective_at_cycle_fk` →
 * `renewal_cycles` FK + transitive `renewal_cycles_member_fk` →
 * `members`. Tests that insert into `scheduled_plan_changes` MUST seed
 * a matching (member, renewal_cycle) pair first.
 *
 * Inline-fixture pattern from `tests/integration/renewals/tier-upgrade-
 * pending.test.ts:103-143` extracted here so multiple test files can
 * reuse it without duplicating ~30 LOC of fixture scaffolding.
 *
 * Cleanup: rows seeded via this helper are wiped by the canonical
 * `test-tenant.cleanup` (which now deletes `renewal_cycles` after
 * `scheduled_plan_changes` and before `members` — see test-tenant.ts).
 *
 * Note on RLS: this helper runs as `chamber_app` inside `runInTenant`,
 * so RLS scopes the writes correctly. Cleanup runs as
 * `neondb_owner` (BYPASSRLS) to wipe across tenants.
 */
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { DEFAULT_TEST_BENEFIT_MATRIX } from './test-benefit-matrix';
import { createActiveTestUser } from './test-users';
import type { TenantContext } from '@/modules/tenants';

export interface SeedRenewalCycleSpec {
  readonly tenant: TenantContext;
  /** Defaults to `randomUUID()` if omitted. */
  readonly memberId?: string;
  /** Defaults to `randomUUID()` if omitted. */
  readonly cycleId?: string;
  /** Defaults to 'TH'. */
  readonly country?: string;
  /** Defaults to 'regular'. */
  readonly planIdAtCycleStart?: string;
  /** Defaults to 'regular' (matching tier name). */
  readonly tierAtCycleStart?: string;
}

export interface SeededRenewalCycle {
  readonly memberId: string;
  readonly cycleId: string;
}

/**
 * Seed a `members` row + `renewal_cycles` row in one tx so a subsequent
 * `scheduled_plan_changes` INSERT satisfies migration 0125's FK chain.
 */
export async function seedMemberAndRenewalCycle(
  spec: SeedRenewalCycleSpec,
): Promise<SeededRenewalCycle> {
  const memberId = spec.memberId ?? randomUUID();
  const cycleId = spec.cycleId ?? randomUUID();
  const country = spec.country ?? 'TH';
  const planId = spec.planIdAtCycleStart ?? 'regular';
  const tier = spec.tierAtCycleStart ?? 'regular';

  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const expiresAt = new Date(now + 60 * MS_PER_DAY);

  // FK chain: members → membership_plans → users (created_by/updated_by).
  // Create a real test user so the membership_plans FK is satisfied.
  // Cleanup is handled by `users` cascade-on-delete in test teardown
  // (see test-users.ts header — `audit_log` pollution accepted MVP).
  const owner = await createActiveTestUser();

  await runInTenant(spec.tenant, async (tx) => {
    // Seed prerequisite membership_plan (members_plan_tenant_year_fk).
    // ON CONFLICT DO NOTHING so concurrent seeds for the same
    // (tenant, planId, year) don't collide.
    await tx
      .insert(membershipPlans)
      .values({
        tenantId: spec.tenant.slug,
        planId,
        planYear: 2026,
        planName: { en: `Test ${planId}` },
        // R3 Batch 4a (R3-S2) — non-empty EN required. plan-repo's
        // `rowToPlan` hydrates via `asLocaleText` which rejects empty
        // `en`. Use a non-trivial value so future tests that read the
        // helper-seeded row via `planRepo.findOne` don't crash.
        description: { en: `Test ${planId} description` },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 5_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        isActive: true,
        createdBy: owner.userId,
        updatedBy: owner.userId,
      })
      .onConflictDoNothing();
    await tx.insert(members).values({
      tenantId: spec.tenant.slug,
      memberId,
      companyName: 'Test Co',
      country,
      planId,
      planYear: 2026,
    });
    await tx.insert(renewalCycles).values({
      tenantId: spec.tenant.slug,
      cycleId,
      memberId,
      status: 'upcoming',
      periodFrom: new Date(now - 30 * MS_PER_DAY),
      periodTo: expiresAt,
      expiresAt,
      cycleLengthMonths: 12,
      tierAtCycleStart: tier,
      planIdAtCycleStart: planId,
      frozenPlanPriceThb: '50000.00',
      frozenPlanTermMonths: 12,
      frozenPlanCurrency: 'THB',
    });
  });

  return { memberId, cycleId };
}
