/**
 * #9 forensic — the F8 tier-upgrade apply SKIPS the `members.plan_id` flip when
 * the accepted upgrade's target plan is unresolvable for the applied cycle's
 * fiscal year (money-safe: the member stays on the prior plan, never
 * over-billed). BEFORE this change that skip only `logger.warn`ed (rolls off in
 * 30 days). Now it emits a durable, queryable
 * `member_plan_change_billing_effect(effect: 'tier_upgrade_target_unresolvable')`
 * audit so an operator can reconcile a paid-but-not-applied upgrade. Live Neon.
 *
 * Setup: member on `regular` (a live 2026 catalogue row) with an awaiting_payment
 * fiscal-2026 cycle + an `accepted_pending_apply` regular→premium suggestion, but
 * `premium` is NEVER seeded — so the apply's exact-year OFFER lookup for
 * `(premium, 2026)` returns a non-`found` status and the flip is skipped.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { tierUpgradeSuggestions } from '@/modules/renewals/infrastructure/schema-tier-upgrade-suggestions';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { applyPendingTierUpgrade, makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const REGULAR_FEE_MINOR = 5_000_000; // 50,000.00 THB
const PERIOD_FROM = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_TO = new Date('2027-06-01T00:00:00.000Z');

interface Scenario {
  readonly memberId: string;
  readonly cycleId: string;
  readonly suggestionId: string;
}

describe('tier-upgrade target unresolvable — forensic audit (#9)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  async function seedUnresolvableUpgrade(): Promise<Scenario> {
    const memberId = randomUUID();
    const cycleId = randomUUID();
    const suggestionId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Unresolvable Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'regular',
        planYear: 2026,
        turnoverThb: 120_000_000,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      });
      await tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Unresolve',
        lastName: 'Target',
        email: `unres-${memberId.slice(0, 8)}@example.com`,
        isPrimary: true,
        preferredLanguage: 'en',
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: PERIOD_FROM,
        periodTo: PERIOD_TO,
        expiresAt: PERIOD_TO,
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: 'regular',
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
      });
      // regular→premium accepted, but `premium` is never seeded → the apply's
      // exact-year OFFER lookup for (premium, 2026) returns non-`found`.
      await tx.insert(tierUpgradeSuggestions).values({
        tenantId: tenant.ctx.slug,
        suggestionId,
        memberId,
        fromPlanId: 'regular',
        toPlanId: 'premium',
        reasonCode: 'declared_turnover_above_threshold',
        evidenceJsonb: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: 120_000_000,
          thresholdMetAt: new Date().toISOString(),
        },
        status: 'accepted_pending_apply',
        acceptedAt: new Date(),
        acceptedByUserId: admin.userId,
        targetApplyAtCycleId: cycleId,
      });
    });

    return { memberId, cycleId, suggestionId };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // ONLY `regular` is offered — `premium` deliberately absent.
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'regular',
        planName: { en: 'Regular' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
        annualFeeMinorUnits: REGULAR_FEE_MINOR,
        minTurnoverMinorUnits: 50_000_000,
        renewalTierBucket: 'regular',
      }),
    );
  }, 180_000);

  afterAll(async () => {
    for (const q of [
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(membershipPlans).where(eq(membershipPlans.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  beforeEach(async () => {
    for (const q of [
      db.delete(tierUpgradeSuggestions).where(eq(tierUpgradeSuggestions.tenantId, tenant.ctx.slug)),
      db.delete(renewalCycles).where(eq(renewalCycles.tenantId, tenant.ctx.slug)),
      db.delete(contacts).where(eq(contacts.tenantId, tenant.ctx.slug)),
      db.delete(members).where(eq(members.tenantId, tenant.ctx.slug)),
      db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)),
    ]) {
      await q.catch(() => {});
    }
  });

  it('emits member_plan_change_billing_effect(tier_upgrade_target_unresolvable) and leaves the member on the prior plan', async () => {
    const scenario = await seedUnresolvableUpgrade();

    const result = await applyPendingTierUpgrade(makeRenewalsDeps(tenant.ctx.slug), {
      tenantId: tenant.ctx.slug,
      cycleId: scenario.cycleId,
      invoiceId: randomUUID(),
      correlationId: randomUUID(),
      requestId: null,
    });
    // The skip is money-safe, NOT an error — the apply must still succeed.
    expect(result.ok, `applyPendingTierUpgrade: ${JSON.stringify(result.ok ? null : result.error)}`).toBe(true);

    // The plan flip was SKIPPED — the member stays on the prior plan.
    const [member] = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId })
        .from(members)
        .where(eq(members.memberId, scenario.memberId)),
    );
    expect(member?.planId).toBe('regular');

    // The forensic audit row landed with the precise effect + payload.
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ payload: auditLog.payload })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'member_plan_change_billing_effect'),
          ),
        ),
    );
    const forensic = rows.find(
      (r) =>
        (r.payload as { member_id?: string } | null)?.member_id ===
        scenario.memberId,
    );
    expect(forensic, 'a member_plan_change_billing_effect audit must land for the skipped flip').toBeDefined();
    const payload = forensic!.payload as {
      effect: string;
      new_plan_id: string;
      old_plan_id: string;
      cycle_id: string;
    };
    expect(payload.effect).toBe('tier_upgrade_target_unresolvable');
    expect(payload.old_plan_id).toBe('regular');
    expect(payload.new_plan_id).toBe('premium');
    expect(payload.cycle_id).toBe(scenario.cycleId);
  }, 120_000);
});
