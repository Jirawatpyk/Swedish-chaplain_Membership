/**
 * F8 renewal benefit-summary — F8→F9 wiring integration test (live Neon).
 *
 * Pins the cross-module read path retired the MVP stub: `loadRenewalSummary`
 * now resolves the member's metered benefit consumption through the
 * `benefitConsumptionReader` port → the insights adapter
 * (`benefitConsumptionReaderInsights`) → the F9 `computeBenefitUsage`
 * use-case → live Neon (the SAME source `/portal/benefits` consumes).
 *
 * The unit suite mocks the reader; this drives the REAL adapter chain end
 * to end so a cross-module SQL / wiring / RLS regression surfaces here
 * (mocks hide it). A plan granting `eblast_per_year > 0` (the default test
 * matrix grants 1) means insights yields an `eblast` quantifiable entry,
 * which the adapter maps to a `{ key:'eblast', quota }` consumption entry —
 * so `benefitsAvailable` MUST be true and the entry present. No broadcasts
 * are seeded, so `used` is legitimately 0 (cap present, consumption zero).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { loadRenewalSummary, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('F8 renewal benefit-summary — F8→F9 wiring integration', () => {
  let tenantA: TestTenant;
  let user: TestUser;
  let memberId: string;
  let cycleId: string;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenantA = await createTestTenant();

    planId = `f8-benefit-${randomUUID().slice(0, 8)}`;
    memberId = randomUUID();
    cycleId = randomUUID();

    // Plan grants eblast_per_year: 1 (DEFAULT_TEST_BENEFIT_MATRIX) at
    // planYear 2026 — matches the member's plan_year below so insights
    // `getEntitlements(planId, planYear)` resolves a non-null entitlement.
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Benefit Wiring Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );

    // Member ON that plan — insights `findPlanIdentity` reads
    // (members.plan_id, members.plan_year) as the entitlement source.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Benefit Wiring Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );

    // Payable cycle for the member (benefit summary renders regardless of
    // cycle status; awaiting_payment is the canonical confirm-page state).
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date('2026-06-01T00:00:00Z'),
        periodTo: new Date('2027-06-01T00:00:00Z'),
        expiresAt: new Date('2027-06-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await db
      .delete(auditLog)
      .where(eq(auditLog.tenantId, tenantA.ctx.slug))
      .catch(() => {});
    await tenantA.cleanup().catch(() => {});
  }, 120_000);

  it('resolves benefit consumption from F9 insights → benefitsAvailable TRUE + eblast entry with quota', async () => {
    const deps = makeRenewalsDeps(tenantA.ctx.slug);
    const result = await loadRenewalSummary(deps, {
      tenantId: tenantA.ctx.slug,
      cycleId,
      memberId,
      actorRole: 'member',
      actorUserId: user.userId,
      correlationId: `benefit-wiring-${randomUUID().slice(0, 8)}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    }

    // The real insights read ran against live Neon and yielded the plan's
    // eblast entitlement — the page no longer renders "unavailable".
    expect(result.value.benefitsAvailable).toBe(true);

    const eblast = result.value.benefits.find((b) => b.key === 'eblast');
    expect(eblast, 'expected an eblast benefit entry from F9 insights').toBeTruthy();
    expect(typeof eblast?.quota).toBe('number');
    expect(eblast?.quota).toBe(1); // DEFAULT_TEST_BENEFIT_MATRIX eblast_per_year
    expect(eblast?.used).toBe(0); // no broadcasts seeded → zero consumption

    // cultural_tickets_per_year is 0 in the default matrix → insights omits
    // it (no 0-grant read), so no cultural_ticket entry is emitted.
    expect(
      result.value.benefits.some((b) => b.key === 'cultural_ticket'),
    ).toBe(false);
  }, 120_000);
});
