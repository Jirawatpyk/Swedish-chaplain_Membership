/**
 * G2 — `plan_bundle_changed` confirmation audit (US3 AS5 / FR-010).
 *
 * Spec: specs/005-members-contacts/spec.md US3 AS5
 *
 * When `changePlan` is called for a Partnership plan whose
 * `includesCorporatePlanId` differs from the current plan, the use-case:
 *
 *   WITHOUT `confirm_bundle_change: true`:
 *     Returns `bundle_change_requires_confirmation` error — no
 *     `plan_bundle_changed` audit event is written.
 *
 *   WITH `confirm_bundle_change: true`:
 *     Persists the plan change atomically + emits a `plan_bundle_changed`
 *     audit row carrying the old/new corporate-plan-id payload.
 *
 * This tests the audit invariant specifically — the affected-count
 * query (SC-008) is covered by `bundle-change-warning.test.ts`.
 *
 * Payload shape read from `change-plan.ts` lines 288–302:
 *   {
 *     member_id: MemberId,
 *     plan_id: string,           // the new plan id
 *     old_includes_corporate_plan_id: string | null,
 *     new_includes_corporate_plan_id: string | null,
 *   }
 *
 * Pattern mirrors `change-plan-emits-both-audits.test.ts`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { createMember, changePlan } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

// Benefit matrix used for all seeded plans — values are irrelevant to
// the bundle-change logic; they exist solely to satisfy NOT NULL constraints.
const CORPORATE_MATRIX: BenefitMatrix = {
  eblast_per_year: 2,
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

const PARTNERSHIP_MATRIX: BenefitMatrix = {
  eblast_per_year: 0,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'full_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: true,
  cultural_tickets_per_year: 2,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: true,
  // Complete PartnershipBenefits shape required by BenefitMatrix discriminated
  // union. `partnership: null` = corporate; non-null = partnership tier.
  // Field set mirrors the Diamond-tier fixture in
  // tests/integration/events/archive-event.test.ts.
  partnership: {
    event_tickets_included: 6,
    booth_included: true,
    rollup_logo_at_events: true,
    logo_on_merch: true,
    video_duration_minutes: 1.5,
    video_frequency_scope: 'all_events',
    website_logo_months: 12,
    banner_per_year: 20,
    newsletter_promotion: true,
    enewsletter_logo: true,
    directory_ad_position: 'pages_1_and_2',
  },
};

interface SeedPlanOpts {
  planId: string;
  planName: string;
  planCategory: 'corporate' | 'partnership';
  includesCorporatePlanId?: string | null;
  matrix: BenefitMatrix;
}

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  opts: SeedPlanOpts,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId: opts.planId,
      planYear: 2026,
      planName: { en: opts.planName },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: opts.planCategory,
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
      includesCorporatePlanId: opts.includesCorporatePlanId ?? null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: opts.matrix,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

describe('G2 — changePlan plan_bundle_changed audit (US3 AS5 / FR-010)', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {
        // best-effort
      }
    }
  });

  it(
    'G2a: changing to a Partnership plan with a DIFFERENT bundled corporate-plan-id ' +
      'WITHOUT confirm_bundle_change returns bundle_change_requires_confirmation ' +
      'and emits NO plan_bundle_changed audit',
    async () => {
      // --- Arrange ---
      const { a: tenant, b: _unused } = await createTwoTestTenants();
      cleanups.push(tenant.cleanup, _unused.cleanup);
      const user = await createActiveTestUser('admin');

      // Seed three plans:
      //   corpPlanA — the member's initial corporate plan
      //   corpPlanB — a different corporate plan (simulates the second bundle)
      //   partnerPlan — a Partnership tier that bundles corpPlanB (≠ corpPlanA)
      const slug = randomUUID().slice(0, 8);
      const corpPlanAId = `g2a-corp-a-${slug}`;
      const corpPlanBId = `g2a-corp-b-${slug}`;
      const partnerPlanId = `g2a-partner-${slug}`;

      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, {
        planId: corpPlanAId,
        planName: 'G2 Corp A',
        planCategory: 'corporate',
        matrix: CORPORATE_MATRIX,
      });
      await seedPlan(tenant, user, {
        planId: corpPlanBId,
        planName: 'G2 Corp B',
        planCategory: 'corporate',
        matrix: CORPORATE_MATRIX,
      });
      // Partnership plan bundles corpPlanB — switch from corpPlanA triggers
      // a bundle-change detection (oldBundle=null, newBundle=corpPlanBId).
      await seedPlan(tenant, user, {
        planId: partnerPlanId,
        planName: 'G2 Partnership',
        planCategory: 'partnership',
        includesCorporatePlanId: corpPlanBId,
        matrix: PARTNERSHIP_MATRIX,
      });

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `g2a-${randomUUID().slice(0, 8)}`;

      // Seed a member on corpPlanA
      const created = await createMember(
        {
          company_name: `G2a Test Co ${seedSlug}`,
          country: 'SE',
          plan_id: corpPlanAId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Gustav',
            last_name: 'G2a',
            email: `${seedSlug}@example.com`,
            preferred_language: 'sv' as const,
          },
        },
        { actorUserId: user.userId, requestId: `g2a-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok) throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      const requestId = `g2a-change-${seedSlug}`;

      // --- Act: attempt WITHOUT confirm_bundle_change ---
      const result = await changePlan(
        memberId,
        {
          new_plan_id: partnerPlanId,
          new_plan_year: 2026,
          // confirm_bundle_change intentionally omitted
        },
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert: error type is bundle_change_requires_confirmation ---
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('bundle_change_requires_confirmation');
        if (result.error.type === 'bundle_change_requires_confirmation') {
          // old bundle: corpPlanA has includesCorporatePlanId = null
          expect(result.error.oldBundleCorporatePlanId).toBeNull();
          // new bundle: partnerPlan includes corpPlanB
          expect(result.error.newBundleCorporatePlanId).toBe(corpPlanBId);
        }
      }

      // --- Assert: NO plan_bundle_changed audit row for this member ---
      const bundleRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_bundle_changed'),
          ),
        );
      const matching = bundleRows.filter(
        (r) => (r.payload as { member_id?: string }).member_id === memberId,
      );
      expect(matching).toHaveLength(0);
    },
    60_000,
  );

  it(
    'G2b: changing to a Partnership plan with a DIFFERENT bundled corporate-plan-id ' +
      'WITH confirm_bundle_change: true emits plan_bundle_changed audit ' +
      'with correct old/new corporate-plan-id payload',
    async () => {
      // --- Arrange ---
      const { a: tenant, b: _unused } = await createTwoTestTenants();
      cleanups.push(tenant.cleanup, _unused.cleanup);
      const user = await createActiveTestUser('admin');

      const slug = randomUUID().slice(0, 8);
      const corpPlanAId = `g2b-corp-a-${slug}`;
      const corpPlanBId = `g2b-corp-b-${slug}`;
      const partnerPlanId = `g2b-partner-${slug}`;

      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, {
        planId: corpPlanAId,
        planName: 'G2b Corp A',
        planCategory: 'corporate',
        matrix: CORPORATE_MATRIX,
      });
      await seedPlan(tenant, user, {
        planId: corpPlanBId,
        planName: 'G2b Corp B',
        planCategory: 'corporate',
        matrix: CORPORATE_MATRIX,
      });
      await seedPlan(tenant, user, {
        planId: partnerPlanId,
        planName: 'G2b Partnership',
        planCategory: 'partnership',
        includesCorporatePlanId: corpPlanBId,
        matrix: PARTNERSHIP_MATRIX,
      });

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `g2b-${randomUUID().slice(0, 8)}`;

      const created = await createMember(
        {
          company_name: `G2b Test Co ${seedSlug}`,
          country: 'TH',
          plan_id: corpPlanAId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Beatrix',
            last_name: 'G2b',
            email: `${seedSlug}@example.com`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `g2b-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok) throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      const requestId = `g2b-confirm-${seedSlug}`;

      // --- Act: confirm the bundle change ---
      const result = await changePlan(
        memberId,
        {
          new_plan_id: partnerPlanId,
          new_plan_year: 2026,
          confirm_bundle_change: true,
        },
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert: plan change succeeded ---
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.planId).toBe(partnerPlanId);
      }

      // --- Assert: plan_bundle_changed audit exists with correct payload ---
      const bundleRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_bundle_changed'),
          ),
        );

      const matching = bundleRows.filter(
        (r) => (r.payload as { member_id?: string }).member_id === memberId,
      );
      expect(matching).toHaveLength(1);

      const bundleAudit = matching[0]!;

      // Verify payload shape from change-plan.ts lines 288-302
      const p = bundleAudit.payload as {
        member_id?: string;
        plan_id?: string;
        old_includes_corporate_plan_id?: string | null;
        new_includes_corporate_plan_id?: string | null;
      };
      expect(p.member_id).toBe(memberId);
      expect(p.plan_id).toBe(partnerPlanId);
      // corpPlanA's includesCorporatePlanId is null
      expect(p.old_includes_corporate_plan_id).toBeNull();
      // partnerPlan includes corpPlanB
      expect(p.new_includes_corporate_plan_id).toBe(corpPlanBId);

      // Audit must be attributed to the correct actor + request
      expect(bundleAudit.actorUserId).toBe(user.userId);
      expect(bundleAudit.requestId).toBe(requestId);

      // The two generic plan-change audits (member_plan_changed +
      // member_plan_manually_changed) must ALSO be present in the same
      // tx — this verifies the atomic triple-emit invariant.
      const genericRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'member_plan_changed'),
          ),
        );
      const genericMatch = genericRows.filter(
        (r) => (r.payload as { member_id?: string }).member_id === memberId,
      );
      expect(genericMatch).toHaveLength(1);
      expect(genericMatch[0]!.requestId).toBe(requestId);
    },
    60_000,
  );

  it(
    'G2c: same-bundle Partnership plan change does NOT emit plan_bundle_changed ' +
      '(no confirmation needed, no bundle audit)',
    async () => {
      // Changing from one Partnership plan to ANOTHER with the SAME
      // bundled corporate plan — this is a plan swap, not a bundle change.
      // The use-case should succeed without confirmation and should NOT
      // emit plan_bundle_changed.

      // --- Arrange ---
      const { a: tenant, b: _unused } = await createTwoTestTenants();
      cleanups.push(tenant.cleanup, _unused.cleanup);
      const user = await createActiveTestUser('admin');

      const slug = randomUUID().slice(0, 8);
      const corpPlanId = `g2c-corp-${slug}`;
      const partnerPlanXId = `g2c-partner-x-${slug}`;
      const partnerPlanYId = `g2c-partner-y-${slug}`;

      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, {
        planId: corpPlanId,
        planName: 'G2c Corp',
        planCategory: 'corporate',
        matrix: CORPORATE_MATRIX,
      });
      // Both partnership plans bundle the SAME corporate plan
      await seedPlan(tenant, user, {
        planId: partnerPlanXId,
        planName: 'G2c Partnership X',
        planCategory: 'partnership',
        includesCorporatePlanId: corpPlanId,
        matrix: PARTNERSHIP_MATRIX,
      });
      await seedPlan(tenant, user, {
        planId: partnerPlanYId,
        planName: 'G2c Partnership Y',
        planCategory: 'partnership',
        includesCorporatePlanId: corpPlanId, // SAME corp plan as X
        matrix: PARTNERSHIP_MATRIX,
      });

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `g2c-${randomUUID().slice(0, 8)}`;

      // Start member on partnerPlanX
      const created = await createMember(
        {
          company_name: `G2c Test Co ${seedSlug}`,
          country: 'SE',
          plan_id: partnerPlanXId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Cecil',
            last_name: 'G2c',
            email: `${seedSlug}@example.com`,
            preferred_language: 'sv' as const,
          },
        },
        { actorUserId: user.userId, requestId: `g2c-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok) throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      const requestId = `g2c-same-bundle-${seedSlug}`;

      // --- Act: switch to partnerPlanY (same bundle, no confirm required) ---
      const result = await changePlan(
        memberId,
        {
          new_plan_id: partnerPlanYId,
          new_plan_year: 2026,
        },
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert: succeeded without confirmation ---
      expect(result.ok).toBe(true);

      // --- Assert: NO plan_bundle_changed audit ---
      const bundleRows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            eq(auditLog.eventType, 'plan_bundle_changed'),
          ),
        );
      const matching = bundleRows.filter(
        (r) => (r.payload as { member_id?: string }).member_id === memberId,
      );
      expect(matching).toHaveLength(0);
    },
    60_000,
  );
});
