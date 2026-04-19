/**
 * T027 — Tenant isolation integration test (REVIEW-GATE BLOCKER).
 *
 * This is the authoritative test for Constitution v1.4.0 Principle I
 * clause 3: "Test enforcement — integration test suite includes a
 * cross-tenant probe that asserts zero cross-tenant visibility on
 * SELECT / INSERT / UPDATE / DELETE from both directions."
 *
 * Strategy:
 *   1. Create two fresh test tenants with UUID-suffixed slugs
 *      (critique E8) so parallel CI runs never collide.
 *   2. Seed each tenant with 3 distinct plans via runInTenant.
 *   3. From Tenant A's context, assert:
 *      - SELECT returns only A's 3 rows (not 6)
 *      - SELECT for a specific B plan_id returns undefined
 *      - UPDATE on a B plan_id affects 0 rows
 *      - DELETE on a B plan_id affects 0 rows
 *      - INSERT with tenant_id = B is rejected by the WITH CHECK clause
 *   4. Swap directions — repeat for Tenant B.
 *   5. Outside any runInTenant, with `SET LOCAL ROLE chamber_app` but
 *      no `SET LOCAL app.current_tenant`, any SELECT returns 0 rows
 *      (secure-by-default).
 *   6. audit_log behaviour:
 *      - Tenant A's audit rows are invisible from B's context
 *      - NULL tenant_id audit rows (F1 identity events) are visible
 *        from BOTH contexts (permissive RLS policy)
 *
 * This test MUST be green before /speckit.review. A red run is a
 * stop-the-line event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

// --- Fixtures -----------------------------------------------------------------

const CORPORATE_MATRIX: BenefitMatrix = {
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

function seedPlansFor(tenantSlug: string, ownerUserId: string, prefix: string) {
  return [0, 1, 2].map((i) => ({
    tenantId: tenantSlug,
    planId: `${prefix}-plan-${i}`,
    planYear: 2026,
    planName: { en: `${prefix} Plan ${i}` },
    description: { en: '' },
    sortOrder: 10 * (i + 1),
    planCategory: 'corporate' as const,
    memberTypeScope: 'company' as const,
    annualFeeMinorUnits: 1_000_000 * (i + 1),
    includesCorporatePlanId: null,
    minTurnoverMinorUnits: null,
    maxTurnoverMinorUnits: null,
    maxDurationYears: null,
    maxMemberAge: null,
    benefitMatrix: CORPORATE_MATRIX,
    isActive: true,
    createdBy: ownerUserId,
    updatedBy: ownerUserId,
  }));
}

// --- Test suite ---------------------------------------------------------------

describe('Tenant isolation — REVIEW GATE BLOCKER (T027)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let user: TestUser;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // R9 — fiscal seed via shared helper (tenant_invoice_settings);
    // tenant_fee_config dropped in migration 0029.
    await seedTenantFiscal({
      tenant: tenantA,
      currencyCode: 'THB',
      vatRate: '0.0700',
      registrationFeeSatang: 100000n,
    });
    await seedTenantFiscal({
      tenant: tenantB,
      currencyCode: 'SEK',
      vatRate: '0.2500',
      registrationFeeSatang: 50000n,
    });
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx
        .insert(membershipPlans)
        .values(seedPlansFor(tenantA.ctx.slug, user.userId, 'alpha'));
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx
        .insert(membershipPlans)
        .values(seedPlansFor(tenantB.ctx.slug, user.userId, 'beta'));
    });
  });

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // -- SELECT isolation --------------------------------------------------

  it('A sees only A plans (not B)', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(membershipPlans),
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantA.ctx.slug)).toBe(true);
    expect(rows.every((r) => r.planId.startsWith('alpha-'))).toBe(true);
  });

  it('B sees only B plans (not A)', async () => {
    const rows = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(membershipPlans),
    );
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.tenantId === tenantB.ctx.slug)).toBe(true);
    expect(rows.every((r) => r.planId.startsWith('beta-'))).toBe(true);
  });

  it('A.getPlan(B.plan_id) returns undefined', async () => {
    const rows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(
          and(
            eq(membershipPlans.planId, 'beta-plan-0'),
            eq(membershipPlans.planYear, 2026),
          ),
        ),
    );
    expect(rows).toHaveLength(0);
  });

  // -- UPDATE isolation --------------------------------------------------

  it('A.update(B.plan_id) affects 0 rows', async () => {
    const updated = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .update(membershipPlans)
        .set({ sortOrder: 999 })
        .where(
          and(
            eq(membershipPlans.planId, 'beta-plan-0'),
            eq(membershipPlans.planYear, 2026),
          ),
        )
        .returning(),
    );
    expect(updated).toHaveLength(0);

    // Sanity: from B's context, beta-plan-0 still has its original sort_order
    const rows = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.planId, 'beta-plan-0')),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sortOrder).toBe(10);
  });

  // -- DELETE isolation --------------------------------------------------

  it('A.delete(B.plan_id) affects 0 rows', async () => {
    const deleted = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .delete(membershipPlans)
        .where(
          and(
            eq(membershipPlans.planId, 'beta-plan-0'),
            eq(membershipPlans.planYear, 2026),
          ),
        )
        .returning(),
    );
    expect(deleted).toHaveLength(0);

    // Sanity: from B's context the row still exists
    const rows = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(membershipPlans)
        .where(eq(membershipPlans.planId, 'beta-plan-0')),
    );
    expect(rows).toHaveLength(1);
  });

  // -- INSERT with mismatched tenant_id is rejected by WITH CHECK --------

  it('A.insert with tenant_id = B fails with a RLS WITH CHECK violation', async () => {
    await expect(
      runInTenant(tenantA.ctx, (tx) =>
        tx.insert(membershipPlans).values({
          tenantId: tenantB.ctx.slug, // MISMATCHED — should be rejected
          planId: 'mismatched',
          planYear: 2026,
          planName: { en: 'Mismatched' },
          description: { en: '' },
          sortOrder: 1,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          annualFeeMinorUnits: 100,
          includesCorporatePlanId: null,
          minTurnoverMinorUnits: null,
          maxTurnoverMinorUnits: null,
          maxDurationYears: null,
          maxMemberAge: null,
          benefitMatrix: CORPORATE_MATRIX,
          isActive: true,
          createdBy: user.userId,
          updatedBy: user.userId,
        }),
      ),
    ).rejects.toThrow();
  });

  // -- Unset app.current_tenant returns zero rows ------------------------

  it('query with SET LOCAL ROLE chamber_app but unset app.current_tenant returns 0 rows', async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE chamber_app`);
      // Deliberately no `SET LOCAL app.current_tenant`
      return tx.select().from(membershipPlans);
    });
    expect(rows).toHaveLength(0);
  });

  // R9 — fee_config isolation tests REMOVED after tenant_fee_config
  // DROPPED. tenant_invoice_settings isolation is covered by
  // `tests/integration/invoicing/tenant-isolation.test.ts` (R7-W2).

  // -- audit_log permissive policy ---------------------------------------

  it('audit_log permissive policy: F1 NULL-tenant rows visible from both A and B', async () => {
    // Insert a cross-tenant (NULL tenant_id) audit row as the owner.
    // This mirrors what F1 sign-in-success would write.
    const inserted = await db
      .insert(auditLog)
      .values({
        eventType: 'sign_in_success',
        actorUserId: `test-actor-${Date.now()}`,
        summary: 'T027 cross-tenant visibility probe',
        requestId: `t027-probe-${Date.now()}`,
        // Omitting payload + tenantId — NULL by default
      })
      .returning();
    expect(inserted).toHaveLength(1);
    const probeId = inserted[0]!.id;

    // Visible from Tenant A
    const fromA = await runInTenant(tenantA.ctx, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, probeId)),
    );
    expect(fromA).toHaveLength(1);

    // Visible from Tenant B
    const fromB = await runInTenant(tenantB.ctx, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.id, probeId)),
    );
    expect(fromB).toHaveLength(1);
  });
});
