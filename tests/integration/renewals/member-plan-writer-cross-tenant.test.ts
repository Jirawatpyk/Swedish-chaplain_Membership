/**
 * Plan-change -> billing remediation (Package B1) — cross-tenant safety for the
 * F8 → F3 member-plan WRITE adapter. Live Neon Singapore via .env.local.
 *
 * Constitution Principle I (Review-Gate blocker): the writer is a WRITE to a
 * tenant-scoped table. It MUST thread the caller's tx (RLS via the inherited
 * GUC), never the pool-global `db`. This test proves it: called with tenant X's
 * tx and tenant Y's memberId, RLS filters the row → the writer updates NOTHING
 * (returns null; member Y untouched). A positive control proves the writer DOES
 * write when correctly scoped, so the negative case is not a false pass from a
 * no-op writer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { memberPlanWriterDrizzle } from '@/modules/renewals/infrastructure/ports-adapters/member-plan-writer-drizzle';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('memberPlanWriterDrizzle cross-tenant safety (Package B1)', () => {
  let tenantX: TestTenant;
  let tenantY: TestTenant;
  let admin: TestUser;
  let memberX: string;
  let memberY: string;

  async function seedTenant(tenant: TestTenant): Promise<string> {
    await runInTenant(tenant.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'plan-a',
        planName: { en: 'Plan A' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId: 'plan-b',
        planName: { en: 'Plan B' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      });
    });
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `XT Co ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: 'plan-a',
        planYear: 2026,
        registrationFeePaid: true,
        registrationDate: '2020-01-01',
      }),
    );
    return memberId;
  }

  async function readPlan(
    tenant: TestTenant,
    memberId: string,
  ): Promise<{ planId: string; planYear: number }> {
    const rows = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ planId: members.planId, planYear: members.planYear })
        .from(members)
        .where(eq(members.memberId, memberId)),
    );
    return { planId: rows[0]!.planId, planYear: rows[0]!.planYear };
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenantX = await createTestTenant();
    tenantY = await createTestTenant();
    memberX = await seedTenant(tenantX);
    memberY = await seedTenant(tenantY);
  }, 180_000);

  afterAll(async () => {
    for (const t of [tenantX, tenantY]) {
      if (!t) continue;
      await db.delete(members).where(eq(members.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(membershipPlans).where(eq(membershipPlans.tenantId, t.ctx.slug)).catch(() => {});
      await t.cleanup().catch(() => {});
    }
  }, 60_000);

  it("writes NOTHING when called with tenant X's tx and tenant Y's memberId", async () => {
    const result = await runInTenant(tenantX.ctx, (tx) =>
      memberPlanWriterDrizzle.writePlanIdInTx(
        tx,
        tenantX.ctx.slug,
        memberY, // foreign member — RLS must filter it out
        'plan-b',
        2026,
      ),
    );
    // RLS filtered the row → no update → null (the no-oracle contract).
    expect(result, 'cross-tenant write must resolve to null (nothing written)').toBeNull();

    // Member Y is untouched — still on plan-a.
    const y = await readPlan(tenantY, memberY);
    expect(y.planId, 'member Y plan_id unchanged').toBe('plan-a');
    expect(y.planYear, 'member Y plan_year unchanged').toBe(2026);
  }, 60_000);

  it('positive control: writes when correctly scoped to its own tenant', async () => {
    const result = await runInTenant(tenantX.ctx, (tx) =>
      memberPlanWriterDrizzle.writePlanIdInTx(
        tx,
        tenantX.ctx.slug,
        memberX,
        'plan-b',
        2026,
      ),
    );
    expect(result).toEqual({ planId: 'plan-b', planYear: 2026 });

    const x = await readPlan(tenantX, memberX);
    expect(x.planId, 'member X plan_id flipped').toBe('plan-b');
    expect(x.planYear).toBe(2026);
  }, 60_000);
});
