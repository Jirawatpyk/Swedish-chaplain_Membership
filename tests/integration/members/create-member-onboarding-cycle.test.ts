/**
 * F8-completion Slice 1 · Task 1.6 — createMember onboarding listener,
 * end-to-end against live Neon.
 *
 * Wires the REAL `f8OnCreateMemberCallbacks` factory into `createMember`
 * (exactly as `api/members/route.ts` does when F8 is on) and asserts the
 * post-commit listener creates the new member's initial renewal cycle:
 *
 *   - exactly ONE `upcoming` cycle, anchored at the member's
 *     `registration_date`, frozen at the resolved plan price;
 *   - a `renewal_cycle_created` audit row exists for that cycle;
 *   - an idempotency replay (the same onboarding event fired again) does
 *     NOT create a 2nd cycle (`findActiveForMemberInTx` no-op).
 *
 * Mirrors `change-plan-post-commit-listeners.test.ts` (the F2→F8 twin) for
 * the seed harness. Constitution Principle I (RLS via runInTenant) +
 * Principle VIII (state↔audit atomicity).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { f8OnCreateMemberCallbacks } from '@/modules/renewals';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

describe('Integration — createMember onboarding listener creates the initial cycle (Task 1.6)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = `f8-onboard-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Onboard Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
        // 5_000_000 minor units → 50000.00 THB frozen price (default).
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(renewalCycles)
      .where(eq(renewalCycles.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await db
      .delete(members)
      .where(eq(members.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 60_000);

  it('creates exactly one upcoming cycle anchored at registration_date, frozen at the plan price', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    const registrationDate = '2026-03-15'; // ISO date

    const created = await createMember(
      {
        company_name: `Onboard Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: registrationDate,
        primary_contact: {
          first_name: 'Olivia',
          last_name: 'Onboard',
          email: `${seedSlug}@onboard.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `onboard-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    // Exactly one cycle for this member.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    expect(cycle.status).toBe('upcoming');
    // Anchored at registration_date (UTC midnight of the ISO date).
    expect(cycle.periodFrom.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    // period_to = period_from + 12 months (gapless).
    expect(cycle.periodTo.toISOString()).toBe('2027-03-15T00:00:00.000Z');
    // Frozen at the resolved plan price (50000.00 from the default seed).
    expect(cycle.frozenPlanPriceThb).toBe('50000.00');
    expect(cycle.tierAtCycleStart).toBe('regular');
    expect(cycle.planIdAtCycleStart).toBe(planId);

    // A renewal_cycle_created audit row exists for this member's cycle.
    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          // `renewal_cycle_created` is in the DB enum (migration 0109) but not
          // yet in the auth audit_log Drizzle pgEnum TS union — cast as the
          // precedent (create-next-cycle-on-paid.test.ts:250).
          eq(auditLog.eventType, 'renewal_cycle_created' as never),
        ),
      );
    const forMember = audit.filter(
      (a) => (a.payload as { member_id?: string }).member_id === memberId,
    );
    expect(forMember).toHaveLength(1);
    expect(
      (forMember[0]!.payload as { cycle_id?: string }).cycle_id,
    ).toBe(cycle.cycleId);
  }, 60_000);

  it('068 R2-1 — a BACKDATED registration_date is anchored to the CURRENT period (cycle expires in the FUTURE, not immediately lapse-eligible)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);
    // Onboarding a long-standing/historical member: registered 2 years ago.
    // WITHOUT current-period anchoring the cycle's period_to would be ~1 year
    // in the PAST → the enter-awaiting + lapse crons would flip the brand-new
    // member to `lapsed` at creation. With the R2-1 anchor it advances to the
    // current period so expires_at is in the FUTURE.
    const now = new Date();
    const twoYearsAgo = new Date(
      Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 15),
    );
    const registrationDate = twoYearsAgo.toISOString().slice(0, 10); // YYYY-MM-DD

    const created = await createMember(
      {
        company_name: `Backdated Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: registrationDate,
        primary_contact: {
          first_name: 'Bram',
          last_name: 'Backdated',
          email: `${seedSlug}@backdated.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `backdated-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select()
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
    const cycle = cycles[0]!;
    // The cycle window covers `now` → expires_at strictly in the future.
    expect(cycle.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(cycle.periodTo.getTime()).toBeGreaterThan(Date.now());
    // period_from must NOT be the raw 2-years-ago registration date — it was
    // advanced forward by whole 12-month terms (anniversary day preserved).
    expect(cycle.periodFrom.getTime()).toBeGreaterThan(twoYearsAgo.getTime());
    expect(cycle.periodFrom.getUTCDate()).toBe(15); // anniversary day kept
    // The member did not silently lapse: an `upcoming` cycle (not lapsed).
    expect(cycle.status).toBe('upcoming');
  }, 60_000);

  it('an idempotency replay (same onboarding event re-fired) does NOT create a 2nd cycle', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const seedSlug = randomUUID().slice(0, 8);

    const created = await createMember(
      {
        company_name: `Replay Co ${seedSlug}`,
        country: 'SE',
        plan_id: planId,
        plan_year: 2026,
        registration_date: '2026-04-01',
        primary_contact: {
          first_name: 'Rudy',
          last_name: 'Replay',
          email: `${seedSlug}@replay.test`,
          preferred_language: 'en' as const,
        },
      },
      { actorUserId: user.userId, requestId: `replay-${seedSlug}` },
      { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
    );
    if (!created.ok)
      throw new Error(`create failed: ${JSON.stringify(created.error)}`);
    const memberId = created.value.memberId;

    // Re-fire the onboarding listener directly (simulating a replay).
    const [listener] = f8OnCreateMemberCallbacks(tenant.ctx.slug);
    await listener!({
      tenantId: tenant.ctx.slug,
      memberId,
      registrationDate: '2026-04-01T00:00:00.000Z',
      planId,
      correlationId: `replay-2-${seedSlug}`,
    });

    // Still exactly one cycle — the in-tx idempotency guard no-ops.
    const cycles = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ id: renewalCycles.cycleId })
        .from(renewalCycles)
        .where(
          and(
            eq(renewalCycles.tenantId, tenant.ctx.slug),
            eq(renewalCycles.memberId, memberId),
          ),
        ),
    );
    expect(cycles).toHaveLength(1);
  }, 60_000);

  // Principle-I (068 speckit-review tests I-2) — tenant-isolation probe on
  // the onboarding-listener path. The `f8OnCreateMemberCallbacks` factory is
  // scoped to tenant A's slug (`makeRenewalsDeps(A)` → its listener opens its
  // OWN `runInTenant(A)` tx), so RLS structurally prevents the onboarding
  // cycle from landing in tenant B. This makes that guarantee an explicit
  // regression net: a repo method that reached for the pool-global `db`
  // instead of the threaded `tx` would write across tenants and this probe
  // would catch it.
  it('cross-tenant: onboarding a member in tenant A does not create a cycle visible in tenant B (Principle I)', async () => {
    const tenantB = await createTestTenant();
    try {
      // Tenant B starts with ZERO renewal cycles. It must still have zero
      // after tenant A onboards a member through its own listener.
      const beforeB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
      );
      expect(beforeB).toHaveLength(0);

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = randomUUID().slice(0, 8);
      const created = await createMember(
        {
          company_name: `Isolation Co ${seedSlug}`,
          country: 'SE',
          plan_id: planId,
          plan_year: 2026,
          registration_date: '2026-05-01',
          primary_contact: {
            first_name: 'Ingrid',
            last_name: 'Isolation',
            email: `${seedSlug}@isolation.test`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `isolation-${seedSlug}` },
        { ...deps, onboardingListeners: f8OnCreateMemberCallbacks(tenant.ctx.slug) },
      );
      if (!created.ok)
        throw new Error(`create failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // Tenant A got its onboarding cycle...
      const cyclesA = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(
            and(
              eq(renewalCycles.tenantId, tenant.ctx.slug),
              eq(renewalCycles.memberId, memberId),
            ),
          ),
      );
      expect(cyclesA).toHaveLength(1);

      // ...but tenant B still has ZERO cycles (nothing crossed the boundary).
      const afterB = await runInTenant(tenantB.ctx, (tx) =>
        tx
          .select({ id: renewalCycles.cycleId })
          .from(renewalCycles)
          .where(eq(renewalCycles.tenantId, tenantB.ctx.slug)),
      );
      expect(afterB).toHaveLength(0);
    } finally {
      await db
        .delete(renewalCycles)
        .where(eq(renewalCycles.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await db
        .delete(members)
        .where(eq(members.tenantId, tenantB.ctx.slug))
        .catch(() => {});
      await tenantB.cleanup().catch(() => {});
    }
  }, 180_000);
});
