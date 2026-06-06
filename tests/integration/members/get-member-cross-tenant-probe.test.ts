/**
 * G1 — FR-022 cross-tenant probe audit (`member_cross_tenant_probe`).
 *
 * Spec: specs/005-members-contacts/spec.md § Edge Cases
 *
 * When `getMember` is called with a memberId that belongs to a
 * different tenant (invisible via RLS), the use-case:
 *   (a) Returns `not_found` (RLS hides the row — indistinguishable from
 *       a genuinely non-existent member).
 *   (b) Emits exactly ONE `member_cross_tenant_probe` audit row in the
 *       CALLER's tenant, with payload.attempted_member_id = the probed id
 *       and payload.actor_tenant_id = caller's tenant slug.
 *
 * This is a high-signal event because F3 stores PII at scale
 * (~131 members + ~164 contacts day-one). Any miss from an
 * authenticated admin is audited unconditionally per plan.md §
 * Constraints.
 *
 * Pattern mirrors `tests/integration/members/archive-cascade.test.ts`
 * for tenant setup and `change-plan-emits-both-audits.test.ts` for
 * audit_log inspection via drizzle.
 *
 * Constitution v1.4.0 Principle I clause 3: every feature touching
 * tenant-scoped PII MUST include a cross-tenant integration test as a
 * Review-Gate blocker.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db, runInTenant } from '@/lib/db';
import { getMember, asMemberId } from '@/modules/members';
import { buildMemberProbeDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import {
  createTwoTestTenants,
  type TestTenant,
} from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

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

async function seedPlanInTenant(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: `Plan ${planId}` },
      description: { en: 'Test plan' },
      sortOrder: 10,
      planCategory: 'corporate',
      memberTypeScope: 'company',
      annualFeeMinorUnits: 1_000_000,
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

async function seedMemberInTenant(
  tenant: TestTenant,
  planId: string,
): Promise<string> {
  const memberId = randomUUID();
  const contactId = randomUUID();

  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Probe Test Co ${memberId.slice(0, 8)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status: 'active',
      archivedAt: null,
    });
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Probe',
      lastName: 'Target',
      email: `probe-${randomUUID().slice(0, 8)}@example.com`,
      isPrimary: true,
      preferredLanguage: 'en' as const,
    });
  });

  return memberId;
}

describe('G1 — getMember cross-tenant probe emits member_cross_tenant_probe audit (FR-022)', () => {
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
    'G1a: getMember(tenantA, memberB.id) returns not_found ' +
      'AND emits exactly one member_cross_tenant_probe audit for tenantA ' +
      'with payload.attempted_member_id = memberB.id',
    async () => {
      // --- Arrange ---
      const { a: tenantA, b: tenantB } = await createTwoTestTenants();
      cleanups.push(tenantA.cleanup, tenantB.cleanup);
      const user = await createActiveTestUser('admin');

      const planIdA = `g1a-plan-${randomUUID().slice(0, 8)}`;
      const planIdB = `g1b-plan-${randomUUID().slice(0, 8)}`;

      await seedTenantFiscal({ tenant: tenantA, registrationFeeSatang: 100000n });
      await seedTenantFiscal({ tenant: tenantB, registrationFeeSatang: 100000n });
      await seedPlanInTenant(tenantA, user, planIdA);
      await seedPlanInTenant(tenantB, user, planIdB);

      // Seed a real member in tenant B (RLS will hide it from tenant A)
      const memberBId = await seedMemberInTenant(tenantB, planIdB);

      const deps = buildMemberProbeDeps(tenantA.ctx);
      const requestId = `g1-probe-${randomUUID().slice(0, 8)}`;

      // --- Act ---
      const result = await getMember(
        asMemberId(memberBId),
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert (a): result is not_found ---
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('not_found');
      }

      // --- Assert (b): exactly ONE member_cross_tenant_probe audit row
      // in tenantA's audit_log referencing memberBId ---
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'member_cross_tenant_probe'),
          ),
        );

      // Filter to this specific probe to isolate from any other
      // concurrent test tenants sharing the live Neon instance.
      const matching = rows.filter((row) => {
        const p = row.payload as {
          attempted_member_id?: string;
          actor_tenant_id?: string;
        };
        return p.attempted_member_id === memberBId;
      });

      expect(matching).toHaveLength(1);

      const probe = matching[0]!;

      // Payload must carry the probed member id
      expect(
        (probe.payload as { attempted_member_id?: string }).attempted_member_id,
      ).toBe(memberBId);

      // Payload must identify the caller's tenant
      expect(
        (probe.payload as { actor_tenant_id?: string }).actor_tenant_id,
      ).toBe(tenantA.ctx.slug);

      // Audit row must be attributed to the correct actor
      expect(probe.actorUserId).toBe(user.userId);
      expect(probe.requestId).toBe(requestId);
    },
    60_000,
  );

  it(
    'G1b: getMember(tenantA, genuinely-nonexistent-id) also emits ' +
      'member_cross_tenant_probe — any miss is high-signal for PII resources',
    async () => {
      // --- Arrange ---
      const { a: tenantA, b: tenantB } = await createTwoTestTenants();
      cleanups.push(tenantA.cleanup, tenantB.cleanup);
      const user = await createActiveTestUser('admin');
      const planId = `g1b-plan-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant: tenantA, registrationFeeSatang: 100000n });
      await seedPlanInTenant(tenantA, user, planId);

      // A UUID that was never inserted anywhere
      const nonExistentId = randomUUID();
      const deps = buildMemberProbeDeps(tenantA.ctx);
      const requestId = `g1b-miss-${randomUUID().slice(0, 8)}`;

      // --- Act ---
      const result = await getMember(
        asMemberId(nonExistentId),
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert ---
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('not_found');

      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'member_cross_tenant_probe'),
          ),
        );

      const matching = rows.filter(
        (r) =>
          (r.payload as { attempted_member_id?: string }).attempted_member_id ===
          nonExistentId,
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]!.requestId).toBe(requestId);
    },
    60_000,
  );

  it(
    'G1c: getMember with a member that EXISTS in tenantA does NOT emit ' +
      'member_cross_tenant_probe',
    async () => {
      // --- Arrange ---
      const { a: tenantA, b: tenantB } = await createTwoTestTenants();
      cleanups.push(tenantA.cleanup, tenantB.cleanup);
      const user = await createActiveTestUser('admin');
      const planId = `g1c-plan-${randomUUID().slice(0, 8)}`;
      await seedTenantFiscal({ tenant: tenantA, registrationFeeSatang: 100000n });
      await seedPlanInTenant(tenantA, user, planId);

      const memberId = await seedMemberInTenant(tenantA, planId);
      const deps = buildMemberProbeDeps(tenantA.ctx);
      const requestId = `g1c-hit-${randomUUID().slice(0, 8)}`;

      // --- Act ---
      const result = await getMember(
        asMemberId(memberId),
        { actorUserId: user.userId, requestId },
        deps,
      );

      // --- Assert: result is ok (member found) ---
      expect(result.ok).toBe(true);

      // No probe audit for this requestId
      const rows = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenantA.ctx.slug),
            eq(auditLog.eventType, 'member_cross_tenant_probe'),
          ),
        );

      const matching = rows.filter((r) => r.requestId === requestId);
      expect(matching).toHaveLength(0);
    },
    60_000,
  );
});
