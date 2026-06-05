/**
 * F8 Phase 7 / Round 6 review-fix F-003 — `escalateTierUpgrade` integration tests.
 *
 * Closes the AS escalate coverage gap flagged by the staff review:
 *
 *   AS (escalate): "Admin clicks Escalate on a tier-upgrade suggestion;
 *   the system inserts an `at_risk_outreach` row keyed to the
 *   suggestion's member with `template_id='tier_upgrade_escalation_<reasonCode>'`,
 *   reuses the existing `at_risk_outreach_recorded` audit event,
 *   and the suggestion stays in the current state (NOT terminal) so
 *   admin can still Accept/Dismiss after the outreach."
 *
 * Phase 7's prior coverage was only unit-level error class assertions
 * in `ports.test.ts` — the use-case wiring + at_risk_outreach insert
 * + audit emit + suggestion-stays-open invariant had no integration
 * coverage.
 *
 * Test scope:
 *   1. Escalate happy path — `at_risk_outreach` row inserted with
 *      `template_id='tier_upgrade_escalation_declared_turnover_above_threshold'`
 *      AND `at_risk_outreach_recorded` audit emitted with the
 *      template_id.
 *   2. Suggestion stays `open` — escalate is non-terminal.
 *   3. Optional outcome note persisted in `outcome_note` column.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { atRiskOutreach } from '@/modules/renewals/infrastructure/schema-at-risk-outreach';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import {
  escalateTierUpgrade,
  makeRenewalsDeps,
  parseSuggestionId,
  type SuggestionId,
} from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

// 055-member-number — raw member seeds (bypassing the createMember allocator)
// must supply a distinct positive `member_number` per the NOT NULL + per-tenant
// UNIQUE index. Monotonic counter keeps every seed in the shared test tenant
// collision-free.
let memberNumberSeq = 0;
function nextMemberNumber(): number {
  memberNumberSeq += 1;
  return memberNumberSeq;
}

// F4+F8 Satang migration (2026-05-16) — plan-catalogue seeder.
// Mirrors the working tier-upgrade-pending.test.ts pattern; required
// because the members fixture's `planId='regular', planYear=2026`
// triggers FK `members_plan_tenant_year_fk` against membership_plans.
const DEFAULT_TEST_BENEFIT_MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: planId },
      description: { en: 'Test description' },
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
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

interface SeededState {
  readonly memberId: string;
  readonly suggestionId: SuggestionId;
}

async function seedOpenSuggestion(
  tenant: TestTenant,
): Promise<SeededState> {
  const memberId = randomUUID();
  const suggestionUuid = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextMemberNumber(),
      companyName: 'Escalate Probe Co',
      country: 'TH',
      planId: 'regular',
      planYear: 2026,
      turnoverThb: 120_000_000,
    });
    await tx.insert(tierUpgradeSuggestions).values({
      tenantId: tenant.ctx.slug,
      suggestionId: suggestionUuid,
      memberId,
      fromPlanId: 'regular',
      toPlanId: 'premium',
      reasonCode: 'declared_turnover_above_threshold',
      evidenceJsonb: {
        reasonCode: 'declared_turnover_above_threshold',
        turnoverThb: 120_000_000,
        thresholdMetAt: new Date().toISOString(),
      },
      status: 'open',
    });
  });

  const idResult = parseSuggestionId(suggestionUuid);
  if (!idResult.ok) throw new Error('seeded suggestion id failed parse');
  return { memberId, suggestionId: idResult.value };
}

async function clearTenant(tenant: TestTenant): Promise<void> {
  for (const tableQuery of [
    db
      .delete(atRiskOutreach)
      .where(eq(atRiskOutreach.tenantId, tenant.ctx.slug)),
    db
      .delete(tierUpgradeSuggestions)
      .where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
    db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
    db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
  ]) {
    await tableQuery.catch(() => {});
  }
}

describe('F8 escalateTierUpgrade — integration (Round 6 F-003)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // F4+F8 Satang migration (2026-05-16) — seed plan catalogue
    // referenced by the suggestion fixture (FK members → membership_plans).
    await seedPlan(tenant, admin, 'regular');
    await seedPlan(tenant, admin, 'premium');
  }, 180_000);

  afterAll(async () => {
    await clearTenant(tenant).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    await clearTenant(tenant).catch(() => {});
  });

  it('AS (escalate) — happy path: at_risk_outreach inserted + audit emitted + suggestion stays open', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await escalateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestionId).toBe(seeded.suggestionId);
    expect(result.value.outreachId).toMatch(/^[0-9a-f-]{36}$/);

    // at_risk_outreach row inserted with the discriminator template_id.
    const [outreach] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(atRiskOutreach)
        .where(eq(atRiskOutreach.outreachId, result.value.outreachId)),
    );
    expect(outreach).toBeDefined();
    expect(outreach?.memberId).toBe(seeded.memberId);
    expect(outreach?.channel).toBe('email');
    expect(outreach?.templateId).toBe(
      'tier_upgrade_escalation_declared_turnover_above_threshold',
    );
    expect(outreach?.actorUserId).toBe(admin.userId);

    // at_risk_outreach_recorded audit emitted with template_id discriminator.
    // F4+F8 Satang migration (2026-05-16) — filter by seeded
    // member_id; audit_log is append-only across the file (the
    // append-only trigger blocks DELETE) so per-test filtering is
    // the only correct isolation primitive.
    const audits = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'at_risk_outreach_recorded'),
            sql`${auditLog.payload}->>'member_id' = ${seeded.memberId}`,
          ),
        ),
    );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const payload = audits[0]?.payload as Record<string, unknown>;
    expect(payload?.member_id).toBe(seeded.memberId);
    expect(payload?.template_id).toBe(
      'tier_upgrade_escalation_declared_turnover_above_threshold',
    );
    expect(payload?.channel).toBe('email');
    expect(payload?.actor_role).toBe('admin');
  }, 60_000);

  it('Suggestion stays open after escalate (non-terminal action)', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await escalateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);

    const [row] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(tierUpgradeSuggestions)
        .where(eq(tierUpgradeSuggestions.suggestionId, seeded.suggestionId)),
    );
    // After escalate, the suggestion is still admin-actionable.
    expect(row?.status).toBe('open');
    expect(row?.closedAt).toBeNull();
  }, 60_000);

  it('Optional outcomeNote persisted in outcome_note column', async () => {
    const seeded = await seedOpenSuggestion(tenant);
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const note = 'Asked Anna to schedule a discovery call before week-end.';

    const result = await escalateTierUpgrade(deps, {
      tenantId: tenant.ctx.slug,
      suggestionId: seeded.suggestionId,
      outcomeNote: note,
      actorUserId: admin.userId,
      actorRole: 'admin',
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [outreach] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(atRiskOutreach)
        .where(eq(atRiskOutreach.outreachId, result.value.outreachId)),
    );
    expect(outreach?.outcomeNote).toBe(note);
  }, 60_000);
});
