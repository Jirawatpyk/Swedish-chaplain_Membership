/**
 * DV-4 / Constitution Principle I (REVIEW-GATE BLOCKER) — admin in
 * tenant A cannot proxy-submit a broadcast for a member that exists
 * only in tenant B.
 *
 * #18 (single member read) amendment: the proxied-member read now lives
 * in the ROUTE (`drizzleMemberRepo.findById`, RLS-scoped) — the use-case
 * no longer probes via `membersBridge.memberExistsInTenant`. The DB-layer
 * RLS scoping of that single read is exercised by the F3 member-repo
 * cross-tenant tests; under tenant A it resolves the tenant-B id to
 * `repo.not_found` → `memberLookup: { status: 'not_found' }`. This DV-4
 * test pins the APPLICATION-LAYER half of the guarantee: given that
 * not-found lookup, `proxySubmitBroadcast` short-circuits with
 * `broadcast_member_not_found` BEFORE delegating to `submitBroadcast`, so
 * nothing is written in EITHER tenant (verified against live Neon below).
 *
 * A single missed isolation path here would let one chamber's admin send a
 * marketing e-blast charged against another chamber's member quota — a
 * PDPA §28 + GDPR Art. 6 cross-controller leak. Hence Review-Gate blocker.
 *
 * Harness reused verbatim from `tenant-isolation.test.ts`:
 *   - `createTwoTestTenants()` (two UUID-suffixed slugs + FK-ordered cleanup)
 *   - `createActiveTestUser('admin')` (tenant-A acting admin)
 *   - `nextSeedMemberNumber()` / `runInTenant` for the tenant-B seed.
 *
 * Note: the tenant-B member is seeded with a plan whose `eblast_per_year`
 * is generous (1) precisely so that — were RLS to FAIL — the call would
 * proceed past the quota check and attempt a real write. The fact that we
 * still get `broadcast_member_not_found` (not a quota/plan error and not a
 * success) is the positive proof RLS scoped the existence probe to
 * tenant A.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  proxySubmitBroadcast,
  makeProxySubmitBroadcastDeps,
} from '@/modules/broadcasts';
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const ISOLATION_MATRIX: BenefitMatrix = {
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

describe('DV-4 / Principle I — proxy-submit cross-tenant isolation (live Neon)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  let bMemberId: string;
  let bPlanId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed plan + member ONLY in tenant B. Tenant A has nothing.
    bPlanId = `dv4-xt-${randomUUID().slice(0, 8)}`;
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(membershipPlans).values({
        tenantId: tenantB.ctx.slug,
        planId: bPlanId,
        planYear: 2026,
        planName: { en: 'DV-4 Cross-Tenant Plan (tenant B)' },
        description: { en: 'Lives only in tenant B' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: ISOLATION_MATRIX,
        isActive: true,
        createdBy: admin.userId,
        updatedBy: admin.userId,
      }),
    );

    bMemberId = randomUUID();
    await runInTenant(tenantB.ctx, (tx) =>
      tx.insert(members).values({
        tenantId: tenantB.ctx.slug,
        memberId: bMemberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'DV-4 Cross-Tenant Member (tenant B)',
        country: 'TH',
        planId: bPlanId,
        planYear: 2026,
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await tenantA.cleanup().catch((e) => {
      console.error('[DV-4 cross-tenant] tenantA cleanup failed:', e);
    });
    await tenantB.cleanup().catch((e) => {
      console.error('[DV-4 cross-tenant] tenantB cleanup failed:', e);
    });
  });

  it('admin in tenant A proxy-submitting a tenant-B member id → member_not_found, no cross-tenant write', async () => {
    // Deps scoped to tenant A; target member id lives in tenant B.
    const depsTenantA = makeProxySubmitBroadcastDeps(tenantA.ctx.slug);

    const result = await proxySubmitBroadcast(depsTenantA, {
      proxiedMemberId: bMemberId,
      adminUserId: admin.userId,
      tenantDisplayName: 'Tenant A Chamber',
      // #18 — the route's single member read runs under tenant-A's RLS
      // scope, so `drizzleMemberRepo.findById(tenantA, bMemberId)` MISSES
      // the tenant-B row → `repo.not_found` → `memberLookup.not_found`.
      // The use-case short-circuits with `broadcast_member_not_found`
      // before any write, in EITHER tenant.
      memberLookup: { status: 'not_found' },
      subject: 'Cross-tenant proxy attempt',
      bodySource: '<p>hi</p>',
      bodyHtml: '<p>hi</p>',
      segment: { kind: 'all_members' },
      scheduledFor: null,
      requestId: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('broadcast_member_not_found');
    }
  });

  it('no broadcast row written for that member id in EITHER tenant', async () => {
    const rowsInA = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(broadcasts)
        .where(eq(broadcasts.requestedByMemberId, bMemberId)),
    );
    expect(rowsInA).toHaveLength(0);

    const rowsInB = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(broadcasts)
        .where(eq(broadcasts.requestedByMemberId, bMemberId)),
    );
    expect(rowsInB).toHaveLength(0);
  });
});
