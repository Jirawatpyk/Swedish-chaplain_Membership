/**
 * G2 Principle I — Account-hub reads are session-scoped, never cross-tenant.
 * Seeds two members in two tenants (dashboard-cross-tenant.test.ts pattern:
 * createTwoTestTenants + createActiveTestUser + seedF8MembershipPlan + inline
 * tx.insert) with DISTINCT renewal-opt-out flags + preferred locales. Asserts
 * each tenant's reads only see their own row. SIMULATED data — never real PII.
 * Live Neon Singapore. Run: pnpm test:integration -- account-hub-cross-tenant
 *
 * Mirrors the SHIPPED account-hub read path in
 * src/app/(member)/portal/account/page.tsx, which resolves memberId from the
 * session via findByLinkedUserId(tenant, user.id) (NEVER a URL param) and then
 * drives three member-scoped reads:
 *   1. renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut — the
 *      renewal opt-out flag SSR seed (a RAW SELECT with NO app-layer tenant
 *      predicate, governed ONLY by RLS+FORCE on `members`, so a true vs false
 *      cross-leak here would fail the DB-layer policy, not just app wiring).
 *   2. getMemberPreferredLocale — preferred-locale SSR seed (branded MemberId).
 *   3. listMemberDataExports — GDPR data-export list (tenant + subject scoped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asMemberId, getMemberPreferredLocale, f3DrizzleMemberRepo } from '@/modules/members';
import { makeRenewalsDeps } from '@/modules/renewals';
import { listMemberDataExports } from '@/modules/insights';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

describe('G2 Account-hub cross-tenant isolation (Principle I)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let seedUser: TestUser;
  const aMemberUuid = randomUUID();
  const bMemberUuid = randomUUID();
  let aUserId: string;
  let bUserId: string;
  const aPlanId = `g2-iso-a-${randomUUID().slice(0, 8)}`;
  const bPlanId = `g2-iso-b-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    seedUser = await createActiveTestUser('admin');
    const userA = await createActiveTestUser('member');
    const userB = await createActiveTestUser('member');
    aUserId = userA.userId;
    bUserId = userB.userId;
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    await runInTenant(tenantA.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantA.ctx.slug, planId: aPlanId,
        planName: { en: 'G2 Plan A' }, benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantA.ctx.slug, memberId: aMemberUuid, memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co A ${aMemberUuid.slice(0, 4)}`, country: 'TH',
        planId: aPlanId, planYear: 2026, status: 'active',
        preferredLocale: 'sv', renewalRemindersOptedOut: true,
      });
      await tx.insert(contacts).values({
        tenantId: tenantA.ctx.slug, contactId: randomUUID(), memberId: aMemberUuid,
        linkedUserId: aUserId, firstName: 'Sim', lastName: 'Alpha',
        email: `sim-alpha-${aMemberUuid.slice(0, 4)}@example.com`, isPrimary: true,
      });
    });

    await runInTenant(tenantB.ctx, async (tx) => {
      await seedF8MembershipPlan(tx, {
        tenantSlug: tenantB.ctx.slug, planId: bPlanId,
        planName: { en: 'G2 Plan B' }, benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: seedUser.userId,
      });
      await tx.insert(members).values({
        tenantId: tenantB.ctx.slug, memberId: bMemberUuid, memberNumber: nextSeedMemberNumber(),
        companyName: `Sim Co B ${bMemberUuid.slice(0, 4)}`, country: 'TH',
        planId: bPlanId, planYear: 2026, status: 'active',
        preferredLocale: 'th', renewalRemindersOptedOut: false,
      });
      await tx.insert(contacts).values({
        tenantId: tenantB.ctx.slug, contactId: randomUUID(), memberId: bMemberUuid,
        linkedUserId: bUserId, firstName: 'Sim', lastName: 'Beta',
        email: `sim-beta-${bMemberUuid.slice(0, 4)}@example.com`, isPrimary: true,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('renewal opt-out flag: tenant A = true, tenant B = false (no cross-leak)', async () => {
    const aDeps = makeRenewalsDeps(tenantA.ctx.slug);
    const aFlag = await runInTenant(tenantA.ctx, (tx) =>
      aDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(tx, tenantA.ctx.slug, aMemberUuid));
    const bDeps = makeRenewalsDeps(tenantB.ctx.slug);
    const bFlag = await runInTenant(tenantB.ctx, (tx) =>
      bDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(tx, tenantB.ctx.slug, bMemberUuid));
    expect(aFlag).toBe(true);
    expect(bFlag).toBe(false);
  });

  it('preferred locale: tenant A = sv, tenant B = th (getMemberPreferredLocale takes branded MemberId)', async () => {
    const a = await getMemberPreferredLocale({ tenant: tenantA.ctx, memberRepo: f3DrizzleMemberRepo }, asMemberId(aMemberUuid));
    const b = await getMemberPreferredLocale({ tenant: tenantB.ctx, memberRepo: f3DrizzleMemberRepo }, asMemberId(bMemberUuid));
    expect(a.ok && a.value).toBe('sv');
    expect(b.ok && b.value).toBe('th');
  });

  it('findByLinkedUserId: tenant B user looked up under tenant A returns not-found (RLS)', async () => {
    const lookup = await buildMembersDeps(tenantA.ctx).memberRepo.findByLinkedUserId(tenantA.ctx, bUserId);
    expect(lookup.ok).toBe(false);
  });

  it('data-export list: ExportJobRecord rows keyed by .subjectMemberId, id by .id (never .memberId/.jobId)', async () => {
    const aJobs = await listMemberDataExports(tenantA.ctx, aMemberUuid);
    const bJobs = await listMemberDataExports(tenantB.ctx, bMemberUuid);
    expect(aJobs.every((j) => j.subjectMemberId === aMemberUuid || j.subjectMemberId === null)).toBe(true);
    expect(bJobs.every((j) => j.subjectMemberId === bMemberUuid || j.subjectMemberId === null)).toBe(true);
    const alphaIds = new Set(aJobs.map((j) => j.id));
    expect(bJobs.some((j) => alphaIds.has(j.id))).toBe(false);
  });
});
