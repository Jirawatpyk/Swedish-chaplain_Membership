/**
 * 066 §4.4(1)/§7 + §4.6 — MANDATORY cross-tenant integration test for the
 * new invoicing → renewals membership-access read (Principle I Review-Gate
 * blocker).
 *
 * Tenant A owns a member with a lapsed cycle → A's context sees
 * `terminated`. Tenant B's context querying the SAME memberId must NOT see
 * A's cycle (RLS) → the latest-cycle lookup returns null → `full`. This
 * proves the F4 record-payment gate (which consumes this port) can never
 * leak one tenant's membership state into another tenant's payment
 * decision.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { membershipAccessBridge } from '@/modules/invoicing/infrastructure/membership-access-bridge';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('066 invoicing membership-access — cross-tenant isolation (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;
  const memberId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    const planId = `f8-mabx-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Access Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: user.userId,
      }),
    );
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'Access Co',
        country: 'TH',
        planId,
        planYear: 2026,
      }),
    );
    // A LAPSED cycle → deriveMembershipAccess maps to `terminated`.
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId: randomUUID(),
        memberId,
        status: 'lapsed',
        periodFrom: new Date(Date.now() - 400 * MS_PER_DAY),
        periodTo: new Date(Date.now() - 35 * MS_PER_DAY),
        expiresAt: new Date(Date.now() - 35 * MS_PER_DAY),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        closedAt: new Date(Date.now() - 30 * MS_PER_DAY),
        closedReason: 'grace_expired',
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
      await db.delete(members).where(eq(members.tenantId, t.ctx.slug)).catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('tenant A context sees the member as terminated (positive control)', async () => {
    const r = await membershipAccessBridge.getMembershipAccess(tenantA.ctx, memberId);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.access).toBe('terminated');
  });

  it('tenant B context CANNOT see A’s cycle → derives full (RLS isolation)', async () => {
    const r = await membershipAccessBridge.getMembershipAccess(tenantB.ctx, memberId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // No cycle visible under B's RLS → null → full/in_good_standing.
      expect(r.value.access).toBe('full');
      expect(r.value.reason).toBe('in_good_standing');
    }
  });
});
