/**
 * D1 (F8 Phase 2 Wave C-7 verify-run remediation) — pin the
 * `changeMemberPlan` dual-audit invariant.
 *
 * After Wave C-8 / T029b, the `change-plan.ts` use-case emits BOTH
 * `member_plan_changed` AND `member_plan_manually_changed` inside the
 * SAME `runInTenant` tx. F8's supersede listener (Phase 5+ T184)
 * relies on the manual-only event to distinguish admin overrides from
 * auto-applied scheduled plan changes — losing the second emit would
 * silently break the supersede flow.
 *
 * This test asserts both rows land in `audit_log` after a single
 * `changePlan` call against live Neon. Mirrors the pattern from
 * `tests/integration/members/timeline.test.ts` for plan + member seeds.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { changePlan, createMember } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';

const MATRIX: BenefitMatrix = {
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

async function seedPlan(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  planNameEn: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: planNameEn },
      description: { en: 'Test description' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 500_000,
      includesCorporatePlanId: null,
      minTurnoverMinorUnits: null,
      maxTurnoverMinorUnits: null,
      maxDurationYears: null,
      maxMemberAge: null,
      benefitMatrix: MATRIX,
      isActive: true,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
  });
}

describe('Integration — changeMemberPlan emits both member_plan_changed events', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterAll(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {
        // Best-effort
      }
    }
  });

  it(
    'D1: a single changeMemberPlan call lands BOTH audit rows for the same member ' +
      '(member_plan_changed + member_plan_manually_changed) inside the same tx',
    async () => {
      const pair = await createTwoTestTenants();
      cleanups.push(pair.a.cleanup, pair.b.cleanup);
      const tenant = pair.a;
      const user = await createActiveTestUser('admin');

      const oldPlanId = `d1-old-${randomUUID().slice(0, 8)}`;
      const newPlanId = `d1-new-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, oldPlanId, 'D1 Old Plan');
      await seedPlan(tenant, user, newPlanId, 'D1 New Plan');

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `d1-${randomUUID().slice(0, 8)}`;
      const created = await createMember(
        {
          company_name: `D1 Test Co ${seedSlug}`,
          country: 'SE',
          plan_id: oldPlanId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Daisy',
            last_name: 'D1',
            email: `${seedSlug}@example.com`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `d1-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok)
        throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // Flip plan: oldPlanId → newPlanId.
      const r = await changePlan(
        memberId,
        {
          new_plan_id: newPlanId,
          new_plan_year: 2026,
        },
        {
          actorUserId: user.userId,
          requestId: `d1-change-${seedSlug}`,
        },
        deps,
      );
      expect(r.ok).toBe(true);

      // Query audit_log for the two specific event types scoped to this
      // tenant + member.
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.ctx.slug),
            inArray(auditLog.eventType, [
              'member_plan_changed',
              'member_plan_manually_changed',
            ] as const),
          ),
        );

      // member_plan_changed keys the F3 member timeline + last_activity bump
      // via snake `member_id`; member_plan_manually_changed (the F8-supersede
      // event, no timeline renderer) carries camelCase `memberId` so it does
      // NOT add a duplicate raw-summary timeline row / a redundant recency bump.
      const generic = rows.filter(
        (r) =>
          r.eventType === 'member_plan_changed' &&
          (r.payload as { member_id?: string }).member_id === memberId,
      );
      const manual = rows.filter(
        (r) =>
          r.eventType === 'member_plan_manually_changed' &&
          (r.payload as { memberId?: string }).memberId === memberId,
      );
      // Each event should fire EXACTLY ONCE per changeMemberPlan call.
      expect(generic.length).toBe(1);
      expect(manual.length).toBe(1);
      // De-dup invariant: the manual (F8-supersede) event must NOT carry snake
      // member_id (timeline/bump key); the generic event must.
      expect('member_id' in (manual[0]!.payload as object)).toBe(false);
      expect('member_id' in (generic[0]!.payload as object)).toBe(true);

      // Both audit rows should carry the same actor + same request id +
      // same plan-id payload — proves they came from the SAME tx.
      expect(generic[0]?.actorUserId).toBe(user.userId);
      expect(manual[0]?.actorUserId).toBe(user.userId);
      expect(generic[0]?.requestId).toBe(manual[0]?.requestId);
      expect((generic[0]?.payload as { new_plan_id?: string }).new_plan_id).toBe(
        newPlanId,
      );
      expect((manual[0]?.payload as { new_plan_id?: string }).new_plan_id).toBe(
        newPlanId,
      );

      // A1 regression: findLastPlanChangedAt must resolve the timestamp from
      // the member_plan_changed audit. The audit payload key is `member_id`;
      // the query previously read `payload->>'memberId'` (camelCase) and so
      // ALWAYS returned null. Assert it now returns the real change time.
      const lastChanged = await deps.memberRepo.findLastPlanChangedAt(
        tenant.ctx,
        memberId,
      );
      expect(lastChanged.ok).toBe(true);
      if (lastChanged.ok) expect(lastChanged.value).toBeInstanceOf(Date);
    },
    60_000,
  );
});
