/**
 * WP4 / GAP-1 — price parity between what the portal DISPLAYS and what the
 * server FREEZES. Live Neon Singapore via .env.local.
 *
 * The portal renewal page renders each plan option's price from F2
 * `listPlans` (`annual_fee_minor_units`), while `confirmRenewal` classifies
 * the up/downgrade and freezes the §86/4 price from the F8
 * `planLookupForRenewal` port (`priceTHB`, a `decimal(12,2)` string). Those
 * are two DIFFERENT reads of the same catalogue row through two different
 * representations. If they ever drift, the member is shown one price, the
 * downgrade gate classifies against another, and the tax document bills a
 * third.
 *
 * This is the ONLY test that makes the displayed price a contract:
 *   Number(listed.annual_fee_minor_units)
 *     === satangToProcessorAmount(parseThbDecimalToSatang(looked.plan.priceTHB))
 * plus: every plan `listPlans(activeOnly)` shows MUST resolve through
 * `mode:'offer'` (else the member is offered a plan the server will refuse).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { parseThbDecimalToSatang, satangToProcessorAmount } from '@/lib/money';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { asPlanYear, listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { makeRenewalsDeps } from '@/modules/renewals';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const PLAN_YEAR = 2026;

// Deliberately varied magnitudes — including a plan whose minor units do NOT
// end in "00" — so a naive decimal round-trip (e.g. dropping the fractional
// part, or a float multiply) shows up as a mismatch.
const SEEDED = [
  { planId: 'regular', tier: 'regular' as const, fee: 5_000_000 }, // 50,000.00
  { planId: 'premium', tier: 'premium' as const, fee: 9_000_000 }, // 90,000.00
  { planId: 'start-up', tier: 'start_up' as const, fee: 1_234_567 }, // 12,345.67
];

describe('confirm-renewal price parity — listPlans display vs planLookupForRenewal freeze (GAP-1)', () => {
  let tenant: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    // `listPlans` resolves currency + VAT via taxPolicy → tenant_invoice_settings.
    await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
    for (const spec of SEEDED) {
      await runInTenant(tenant.ctx, (tx) =>
        seedF8MembershipPlan(tx, {
          tenantSlug: tenant.ctx.slug,
          planId: spec.planId,
          planName: { en: spec.planId },
          benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
          createdBy: admin.userId,
          annualFeeMinorUnits: spec.fee,
          renewalTierBucket: spec.tier,
          planYear: PLAN_YEAR,
        }),
      );
    }
  }, 180_000);

  afterAll(async () => {
    await db
      .delete(membershipPlans)
      .where(eq(membershipPlans.tenantId, tenant.ctx.slug))
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it('every displayed annual_fee_minor_units equals the frozen priceTHB the server would bill', async () => {
    const plansResult = await listPlans(
      { filter: { year: asPlanYear(PLAN_YEAR), activeOnly: true } },
      buildPlansDeps(tenant.ctx),
    );
    expect(
      plansResult.ok,
      `listPlans: ${JSON.stringify(plansResult.ok ? null : plansResult.error)}`,
    ).toBe(true);
    if (!plansResult.ok) return;

    const listed = plansResult.value.data;
    expect(listed.length, 'seeded plans must be listed').toBe(SEEDED.length);

    const lookup = makeRenewalsDeps(tenant.ctx.slug).planLookupForRenewal;
    let resolvable = 0;

    for (const plan of listed) {
      const looked = await lookup.loadPlanFrozenFields({
        tenantId: tenant.ctx.slug,
        planId: plan.plan_id,
        fiscalYear: PLAN_YEAR,
        mode: 'offer',
      });
      // A plan the portal OFFERS must resolve, or the member picks something
      // confirmRenewal will refuse with plan_not_found / plan_inactive.
      expect(
        looked.status,
        `plan ${plan.plan_id} listed as active but mode:'offer' returned ${looked.status}`,
      ).toBe('found');
      if (looked.status !== 'found') continue;
      resolvable += 1;

      // THE PARITY CONTRACT — displayed minor units === frozen price in satang.
      expect(
        satangToProcessorAmount(parseThbDecimalToSatang(looked.plan.priceTHB)),
        `price parity for plan ${plan.plan_id} (displayed ${plan.annual_fee_minor_units} vs frozen ${looked.plan.priceTHB})`,
      ).toBe(Number(plan.annual_fee_minor_units));
    }

    // Count parity: everything listed is resolvable through the offer path.
    expect(resolvable, 'resolvable-via-offer count vs listed count').toBe(listed.length);
  }, 120_000);
});
