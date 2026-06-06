/**
 * 057 portal redesign §4.1 — Dashboard cross-tenant isolation (live Neon).
 *
 * Principle I Review-Gate blocker: every member-facing read backing the
 * Dashboard (renewal status, outstanding invoices, benefit usage) must be
 * tenant-scoped. We seed a member + cycle in tenant A and assert tenant B's
 * deps — querying the SAME memberId — see NOTHING. The dashboard resolves the
 * member from the session, so a leak here would surface another tenant's data
 * on the landing page.
 *
 * All seed data is SIMULATED (random UUIDs + fake company names) — never real
 * SweCham PII.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { loadMemberRenewalStatus, makeRenewalsDeps } from '@/modules/renewals';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { computeBenefitUsage, makeComputeBenefitUsageDeps } from '@/modules/insights';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const DAY_MS = 86_400_000;

describe('057 dashboard reads — cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seedUser: TestUser;

  const memberId = randomUUID();
  const cycleId = randomUUID();
  const planId = `dash-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    seedUser = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed the plan first — members.plan_id has FK to membership_plans.
    await runInTenant(tenantA.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug,
        planId,
        planName: { en: 'Dash Test Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      }),
    );

    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantA.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co ${memberId.slice(0, 4)}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      }),
    );

    const now = Date.now();
    await runInTenant(tenantA.ctx, (tx) =>
      tx.insert(renewalCycles).values({
        tenantId: tenantA.ctx.slug,
        cycleId,
        memberId,
        status: 'awaiting_payment',
        periodFrom: new Date(now - 30 * DAY_MS),
        periodTo: new Date(now + 20 * DAY_MS),
        expiresAt: new Date(now + 20 * DAY_MS),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: randomUUID(),
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        createdAt: new Date(now - 5 * DAY_MS),
      }),
    );
  }, 120_000);

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await db.delete(renewalCycles).where(eq(renewalCycles.tenantId, t.ctx.slug)).catch(() => {});
    }
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  }, 120_000);

  it('tenant A sees its own renewal cycle', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantA.ctx.slug), {
      tenantId: tenantA.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle?.cycleId).toBe(cycleId);
  });

  it('tenant B cannot see tenant A renewal cycle for the same memberId', async () => {
    const res = await loadMemberRenewalStatus(makeRenewalsDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      memberId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycle).toBeNull();
  });

  it('tenant B cannot see tenant A invoices for the same memberId', async () => {
    const res = await listInvoicesPaged(makeListInvoicesDeps(tenantB.ctx.slug), {
      tenantId: tenantB.ctx.slug,
      offset: 0,
      pageSize: 50,
      includeDrafts: false,
      memberId,
      status: 'issued',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rows).toHaveLength(0);
  });

  it('tenant A sees benefit usage for its own member (positive control)', async () => {
    // The member is seeded in tenant A with a plan that has eblast_per_year=1.
    // computeBenefitUsage returns ok=true with a valid BenefitUsage — the
    // member + plan exist in tenant A's RLS scope.
    const res = await computeBenefitUsage(
      tenantA.ctx,
      { memberId },
      makeComputeBenefitUsageDeps(tenantA.ctx.slug),
    );
    expect(res.ok).toBe(true);
  });

  it('tenant B cannot see tenant A benefit usage for the same memberId', async () => {
    // The memberId belongs to tenant A. When computeBenefitUsage runs under
    // tenant B's RLS context, memberPlanSource.findPlanIdentity returns null
    // (the member row is not visible to tenant B) → use-case returns
    // err({ code: 'member_not_found' }) — no data leak.
    const res = await computeBenefitUsage(
      tenantB.ctx,
      { memberId },
      makeComputeBenefitUsageDeps(tenantB.ctx.slug),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('member_not_found');
  });
});
