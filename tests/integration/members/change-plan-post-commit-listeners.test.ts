/**
 * 063 — F2→F8 manual plan-change listeners run POST-COMMIT (Option A).
 *
 * Design-flaw fix: F8's manual-plan-change listeners (supersede pending
 * tier-upgrade + reschedule renewal cadence) used to run INSIDE F3's
 * `changeMemberPlan` transaction, receiving the SHARED `tx`. The bridge
 * tried to swallow listener failures, but a swallow CANNOT achieve its
 * goal inside a tx: a hard SQL failure poisons the Postgres transaction,
 * so the COMMIT downgrades to ROLLBACK and the plan-flip is silently
 * lost anyway. The use-case loop additionally re-threw, mapping the
 * failure to a `server_error`.
 *
 * After Option A the listeners run AFTER F3's tx commits, each in its
 * OWN `runInTenant` tx. A listener failure is best-effort: the plan-flip
 * is already durable, so the member's plan IS changed + the
 * `member_plan_manually_changed` audit row exists + the use-case returns
 * `ok`, even though the listener failed.
 *
 * This is the canonical RED→GREEN test for the whole change:
 *
 *   - GREEN (this code): a FAILING listener → plan-flip COMMITTED + audit
 *     row present + `ok`.
 *   - RED (the old in-tx code): the same failing listener poisons the tx
 *     / re-throws → plan UNCHANGED + use-case `server_error`.
 *
 * Lives in `tests/integration/members/` because `changePlan` (F3) is the
 * entry point under test; the listener contract is the cross-module
 * F3↔F8 seam.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { changePlan, createMember } from '@/modules/members';
import type { ManualPlanChangeListener } from '@/modules/renewals';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';

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

describe('Integration — changeMemberPlan runs F8 listeners POST-COMMIT (063)', () => {
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
    'a FAILING manual-plan-change listener does NOT roll back the plan-flip — ' +
      'member plan IS changed, member_plan_manually_changed audit exists, use-case returns ok',
    async () => {
      const pair = await createTwoTestTenants();
      cleanups.push(pair.a.cleanup, pair.b.cleanup);
      const tenant = pair.a;
      const user = await createActiveTestUser('admin');

      const oldPlanId = `pc-old-${randomUUID().slice(0, 8)}`;
      const newPlanId = `pc-new-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, oldPlanId, 'PostCommit Old Plan');
      await seedPlan(tenant, user, newPlanId, 'PostCommit New Plan');

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `pc-${randomUUID().slice(0, 8)}`;
      const created = await createMember(
        {
          company_name: `PostCommit Co ${seedSlug}`,
          country: 'SE',
          plan_id: oldPlanId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Polly',
            last_name: 'PostCommit',
            email: `${seedSlug}@example.com`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `pc-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok)
        throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // A listener that ALWAYS fails. Post-commit semantics mean this
      // failure must NOT touch the already-committed plan-flip. Under
      // the OLD in-tx code, this throw poisons the shared tx (and the
      // use-case re-throws) → the plan-flip rolls back → RED.
      let listenerInvoked = false;
      const failingListener: ManualPlanChangeListener = async () => {
        listenerInvoked = true;
        throw new Error('synthetic_listener_failure_post_commit');
      };

      const r = await changePlan(
        memberId,
        { new_plan_id: newPlanId, new_plan_year: 2026 },
        { actorUserId: user.userId, requestId: `pc-change-${seedSlug}` },
        { ...deps, manualPlanChangeListeners: [failingListener] },
      );

      // (1) Use-case returns ok — the plan-flip succeeded; the listener
      // failure is best-effort and does NOT surface as a server_error.
      expect(r.ok).toBe(true);
      if (!r.ok) {
        throw new Error(
          `expected ok, got error: ${JSON.stringify(r.error)} ` +
            '(RED: old in-tx code rolls the plan-flip back on listener failure)',
        );
      }
      // The returned member reflects the new plan.
      expect(r.value.planId as string).toBe(newPlanId);

      // The listener actually ran (proves we exercised the post-commit
      // path, not a no-op short-circuit).
      expect(listenerInvoked).toBe(true);

      // (2) The plan-flip is durable in the DB — re-read the row.
      const [row] = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ planId: members.planId })
          .from(members)
          .where(eq(members.memberId, memberId)),
      );
      expect(row?.planId).toBe(newPlanId);

      // (3) The member_plan_manually_changed audit row exists for this
      // member — proves the F3 tx committed (the audit is written inside
      // the same tx as the plan-flip).
      const auditRows = await db
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
      const manualForMember = auditRows.filter(
        (a) =>
          a.eventType === 'member_plan_manually_changed' &&
          // De-dup fix: manually_changed now carries camelCase memberId (not
          // snake member_id) so it stays out of the F3 timeline/last_activity.
          (a.payload as { memberId?: string }).memberId === memberId,
      );
      expect(manualForMember.length).toBe(1);
      expect(
        (manualForMember[0]?.payload as { new_plan_id?: string }).new_plan_id,
      ).toBe(newPlanId);
    },
    60_000,
  );

  it(
    'happy path — both listeners succeed post-commit; plan-flip committed + listeners ran',
    async () => {
      const pair = await createTwoTestTenants();
      cleanups.push(pair.a.cleanup, pair.b.cleanup);
      const tenant = pair.a;
      const user = await createActiveTestUser('admin');

      const oldPlanId = `pc2-old-${randomUUID().slice(0, 8)}`;
      const newPlanId = `pc2-new-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
      await seedPlan(tenant, user, oldPlanId, 'PostCommit2 Old Plan');
      await seedPlan(tenant, user, newPlanId, 'PostCommit2 New Plan');

      const deps = buildMembersDeps(tenant.ctx);
      const seedSlug = `pc2-${randomUUID().slice(0, 8)}`;
      const created = await createMember(
        {
          company_name: `PostCommit2 Co ${seedSlug}`,
          country: 'SE',
          plan_id: oldPlanId,
          plan_year: 2026,
          primary_contact: {
            first_name: 'Petra',
            last_name: 'PostCommit2',
            email: `${seedSlug}@example.com`,
            preferred_language: 'en' as const,
          },
        },
        { actorUserId: user.userId, requestId: `pc2-seed-${seedSlug}` },
        deps,
      );
      if (!created.ok)
        throw new Error(`seed failed: ${JSON.stringify(created.error)}`);
      const memberId = created.value.memberId;

      // Two succeeding listeners that record the event they received.
      const seen: Array<{ oldPlanId: string; newPlanId: string }> = [];
      const okListener =
        (): ManualPlanChangeListener =>
        async (evt) => {
          seen.push({ oldPlanId: evt.oldPlanId, newPlanId: evt.newPlanId });
        };

      const r = await changePlan(
        memberId,
        { new_plan_id: newPlanId, new_plan_year: 2026 },
        { actorUserId: user.userId, requestId: `pc2-change-${seedSlug}` },
        {
          ...deps,
          manualPlanChangeListeners: [okListener(), okListener()],
        },
      );

      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(r.value.planId as string).toBe(newPlanId);

      // Both listeners ran post-commit with the correct event payload
      // (old = the row's pre-flip plan, new = the requested plan).
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.oldPlanId).toBe(oldPlanId);
        expect(s.newPlanId).toBe(newPlanId);
      }

      // Plan-flip durable.
      const [row] = await runInTenant(tenant.ctx, (tx) =>
        tx
          .select({ planId: members.planId })
          .from(members)
          .where(eq(members.memberId, memberId)),
      );
      expect(row?.planId).toBe(newPlanId);
    },
    60_000,
  );
});
