/**
 * Cluster 2 (G5 + G6) — at-risk scoring for the IMPORTED cohort (live Neon).
 *
 * Imported members have `created_at` = the import instant but a real
 * `registration_date` years earlier, and NO in-system engagement history
 * (never onboarded). Two bugs made the whole cohort read as "at-risk":
 *
 *   G6 — tenure was derived from created_at (import instant), so a decade-long
 *        member read as ~0-day tenure (mis-firing the min-tenure gate).
 *   G5 — zero in-system engagement (eblast/events/cultural) was scored as
 *        disengagement (+50), instead of "no data yet".
 *
 * The fix anchors tenure on registration_date, and skips the engagement factors
 * (undefined → Domain skips, like the payment factor) until the in-system
 * observation window (now − created_at) reaches ENGAGEMENT_OBSERVATION_MIN_DAYS.
 * This test proves BOTH bugs end-to-end for the single AND batch scorers — unit
 * mocks can't cover the registration_date column read + the CTE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { makeRenewalsDeps, recomputeAtRiskScoresBatch } from '@/modules/renewals';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { seedRenewalPolicies } from '../helpers/seed-renewal-policies';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();

describe('at-risk observation window — imported cohort (G5/G6, single + batch)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedRenewalPolicies(tenant.ctx);
    planId = `f8-obs-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Observation Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      });
    });
  }, 180_000);

  afterEach(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(contacts)
      .where(eq(contacts.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  /**
   * Seed a member with NO in-system engagement (no events/broadcasts/cultural),
   * a RECENT last_activity_at (so the contact-update factor stays quiet), a long
   * real membership (registration_date), and a configurable import instant
   * (created_at → the observation window).
   */
  async function seedMember(
    createdAtDaysAgo: number,
    registrationDate = '2019-01-01',
  ): Promise<string> {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Imported Co',
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
        // Real membership start — drives tenure (default: years ago = long tenure).
        registrationDate,
        // Import instant — recent OR old, per the test (drives the obs window).
        createdAt: new Date(NOW_MS - createdAtDaysAgo * MS_PER_DAY),
        // Recent so `days_since_contact_update` does not fire (isolate engagement).
        lastActivityAt: new Date(NOW_MS - 1 * MS_PER_DAY),
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Imported',
        lastName: 'Member',
        email: `imp-${memberId.slice(0, 6)}@acme.example`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'upcoming',
        periodFrom: new Date(NOW_MS - 30 * MS_PER_DAY),
        periodTo: new Date(NOW_MS + 30 * MS_PER_DAY),
        expiresAt: new Date(NOW_MS + 30 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
    });
    return memberId;
  }

  it('single scorer — fresh import: SCORED (tenure from registration_date) but engagement is skipped', async () => {
    const memberId = await seedMember(10); // imported 10 days ago
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(tenant.ctx.slug, memberId);

    // G6 — tenure derives from registration_date (2019 → 1000s of days), NOT
    // created_at (10 days). So the member is SCORED, not min-tenure-skipped.
    expect(result.skippedBelowMinTenure).toBe(false);
    expect(result.tenureDays).toBeGreaterThan(1000);

    // G5 — zero in-system engagement is "no data yet" (observation window < 1
    // quota year), so none of the engagement factors contribute.
    const factorKeys = result.contributions.map((c) => c.factor);
    expect(factorKeys).not.toContain('events_attended_last_12mo_zero');
    expect(factorKeys).not.toContain('e_blast_quota_under_30pct');
    // (cultural is inert on the default plan — cultural_tickets_per_year=0 — so
    // the events + eblast assertions above are what actually prove the G5 gate.)
  }, 60_000);

  it('single scorer — long-observed member (in-system > 1yr): zero engagement IS scored', async () => {
    const memberId = await seedMember(400); // in-system 400 days → past the window
    const deps = makeRenewalsDeps(tenant.ctx.slug);
    const result = await deps.atRiskScorer.scoreMember(tenant.ctx.slug, memberId);

    // Past the observation window, genuine zero usage is real disengagement.
    const factorKeys = result.contributions.map((c) => c.factor);
    expect(factorKeys).toContain('events_attended_last_12mo_zero');
  }, 60_000);

  it('batch scorer — a fresh import scores strictly lower than an otherwise-identical long-observed member', async () => {
    const freshId = await seedMember(10); // engagement gated
    const observedId = await seedMember(400); // engagement scored
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const result = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The registration_date column read + the batch runs cleanly on live Neon.
    expect(result.value.membersFailed).toBe(0);
    // G6 (batch) — neither member is min-tenure-skipped; tenure derives from
    // registration_date (2019), NOT created_at. A batch-G6 revert would skip
    // `fresh` (created 10d < 30d min-tenure) → this would be 1, not 0.
    expect(result.value.membersSkippedBelowTenure).toBe(0);

    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ memberId: members.memberId, riskScore: members.riskScore })
        .from(members),
    );
    const scoreOf = (id: string): number | null =>
      rows.find((r) => r.memberId === id)?.riskScore ?? null;
    const fresh = scoreOf(freshId) ?? 0;
    const observed = scoreOf(observedId) ?? 0;

    // Same member shape except the import instant → the only score difference is
    // the gated engagement factors. The zero-event factor alone is +25.
    expect(observed - fresh).toBeGreaterThanOrEqual(25);
  }, 90_000);

  it('min-tenure gate still fires post-G6 — a genuinely NEW member (recent registration_date) is skipped in BOTH scorers', async () => {
    // Guards that anchoring tenure on registration_date did not disable the
    // FR-035 min-tenure gate: a real new signup (5-day-old membership) must
    // still be skipped — in the single scorer AND the batch.
    const recentReg = new Date(NOW_MS - 5 * MS_PER_DAY)
      .toISOString()
      .slice(0, 10);
    const memberId = await seedMember(5, recentReg);
    const deps = makeRenewalsDeps(tenant.ctx.slug);

    const single = await deps.atRiskScorer.scoreMember(tenant.ctx.slug, memberId);
    expect(single.skippedBelowMinTenure).toBe(true);
    expect(single.contributions).toHaveLength(0);

    const batch = await recomputeAtRiskScoresBatch(deps, {
      tenantId: tenant.ctx.slug,
      correlationId: randomUUID(),
    });
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    expect(batch.value.membersSkippedBelowTenure).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
