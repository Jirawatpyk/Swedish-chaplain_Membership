/**
 * G2 Principle I — Account-hub reads are session-scoped, never cross-tenant.
 * Seeds two members in two tenants (dashboard-cross-tenant.test.ts pattern:
 * createTwoTestTenants + createActiveTestUser + seedF8MembershipPlan + inline
 * tx.insert) with DISTINCT renewal-opt-out flags + preferred locales, plus one
 * `export_jobs` (gdpr_member_archive) row per tenant. SIMULATED data — never
 * real PII. Live Neon Singapore. Run: pnpm test:integration -- account-hub-cross-tenant
 *
 * Mirrors the SHIPPED account-hub read path in
 * src/app/(member)/portal/account/page.tsx, which resolves memberId from the
 * session via findByLinkedUserId(tenant, user.id) (NEVER a URL param) and then
 * drives three member-scoped reads:
 *   1. renewalsDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut — the
 *      renewal opt-out flag SSR seed (a RAW SELECT with NO app-layer tenant
 *      predicate, governed ONLY by RLS+FORCE on `members`).
 *   2. getMemberPreferredLocale → findPreferredLocaleInTx — preferred-locale SSR
 *      seed (also a RAW SELECT with NO app-layer tenant predicate, RLS-only).
 *   3. listMemberDataExports → listRecentForSubject — GDPR data-export list
 *      (tenant + subject + kind scoped, explicit predicate + RLS).
 *
 * What this suite asserts (after the 2026-06-07 follow-up hardening, mirroring
 * the G1 sibling `broadcasts/benefits-tab-tenant-isolation.test.ts`):
 *   - Own-tenant POSITIVE controls — A reads its own true/'sv' flag/locale, A
 *     resolves its own member via findByLinkedUserId, A sees its own export job.
 *     These prove the cross-tenant misses below fail for the RIGHT reason (a
 *     uniformly-broken read would also "not leak" and pass vacuously).
 *   - Cross-tenant RLS-layer PROBES for BOTH RLS-only reads — under tenantA's
 *     `runInTenant` context, reading tenantB's member returns null (flag) /
 *     value-NEVER-'th' (locale). These two reads have NO app-layer tenant
 *     predicate, so a probe is the ONLY way to assert the DB-layer RLS+FORCE
 *     policy on `members` (an app-predicate read would hide a broken policy).
 *   - findByLinkedUserId BOTH directions — A resolves its own user (positive
 *     control); A cannot resolve B's user (cross-tenant not-found).
 *   - Data-export ISOLATION — A's own job is visible (non-empty, correct
 *     subject + id fields); B's job is NOT visible under A's context (the
 *     cross-tenant probe returns empty via the explicit tenant+subject
 *     predicate in listRecentForSubject + RLS+FORCE on `export_jobs`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { exportJobs } from '@/modules/insights/infrastructure/db/schema-insights';
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
      // Seed ONE GDPR export job for A's member so the data-export isolation
      // test (test 4) is non-vacuous: it can assert A SEES its own job AND a
      // cross-tenant probe under A's context CANNOT see B's. `kind` MUST be
      // 'gdpr_member_archive' — listMemberDataExports filters on it. NOT-NULL
      // cols: tenant_id, kind, requested_by (uuid), idempotency_key (the rest
      // default: id/status/created_at/updated_at). subject_member_id is the
      // GDPR data subject. SIMULATED — requested_by reuses the seed admin uuid.
      await tx.insert(exportJobs).values({
        tenantId: tenantA.ctx.slug, kind: 'gdpr_member_archive',
        subjectMemberId: aMemberUuid, requestedBy: seedUser.userId,
        requesterLocale: 'sv', idempotencyKey: `g2-export-a-${randomUUID()}`,
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
      // B's own GDPR export job — the cross-tenant row that A's context must
      // NOT surface in the data-export isolation probe (test 4).
      await tx.insert(exportJobs).values({
        tenantId: tenantB.ctx.slug, kind: 'gdpr_member_archive',
        subjectMemberId: bMemberUuid, requestedBy: seedUser.userId,
        requesterLocale: 'th', idempotencyKey: `g2-export-b-${randomUUID()}`,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  // --- Own-tenant POSITIVE controls -----------------------------------------

  it('renewal opt-out flag: tenant A = true, tenant B = false (own-tenant positive control)', async () => {
    const aDeps = makeRenewalsDeps(tenantA.ctx.slug);
    const aFlag = await runInTenant(tenantA.ctx, (tx) =>
      aDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(tx, tenantA.ctx.slug, aMemberUuid));
    const bDeps = makeRenewalsDeps(tenantB.ctx.slug);
    const bFlag = await runInTenant(tenantB.ctx, (tx) =>
      bDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(tx, tenantB.ctx.slug, bMemberUuid));
    expect(aFlag).toBe(true);
    expect(bFlag).toBe(false);
  });

  it('preferred locale: tenant A = sv, tenant B = th (own-tenant positive control, branded MemberId)', async () => {
    const a = await getMemberPreferredLocale({ tenant: tenantA.ctx, memberRepo: f3DrizzleMemberRepo }, asMemberId(aMemberUuid));
    const b = await getMemberPreferredLocale({ tenant: tenantB.ctx, memberRepo: f3DrizzleMemberRepo }, asMemberId(bMemberUuid));
    expect(a.ok && a.value).toBe('sv');
    expect(b.ok && b.value).toBe('th');
  });

  // Fix 3 (2026-06-07 follow-up) — positive control. The cross-tenant
  // findByLinkedUserId probe below asserts only `.ok === false`, which a
  // uniformly-broken join (always not-found) would also satisfy. This control
  // proves the SAME repo call SUCCEEDS for A's OWN session user, so the
  // cross-tenant miss is specifically RLS+predicate driven, not a wiring fault.
  it('findByLinkedUserId — tenantA resolves its OWN user (positive control)', async () => {
    const lookup = await buildMembersDeps(tenantA.ctx).memberRepo.findByLinkedUserId(tenantA.ctx, aUserId);
    expect(lookup.ok).toBe(true);
    // Member entity exposes the data subject id as `.memberId` (branded MemberId;
    // === a plain UUID string at runtime). Not `.id` / `.jobId`.
    expect(lookup.ok && (lookup.value.memberId as string)).toBe(aMemberUuid);
  });

  // --- Cross-tenant RLS-layer PROBES ----------------------------------------

  // Fix 1 (2026-06-07 follow-up) — DB-layer RLS probe for the renewal flag.
  // readRenewalRemindersOptedOut issues a RAW SELECT with NO app-layer tenant
  // predicate (`WHERE member_id = ?` only), so visibility is governed SOLELY by
  // RLS+FORCE on `members`. A cross-tenant probe is the ONLY way to assert that
  // DB-layer policy — the own-tenant reads above cannot, because they read each
  // tenant's row under its own context. Under A's context, B's row is invisible
  // (0 rows) → the adapter folds `rows[0]?.optedOut ?? null` to null. If this
  // returned B's `false` instead of null, RLS+FORCE on `members` is broken.
  it('renewal flag — tenantA context cannot read tenantB member (RLS layer)', async () => {
    const aDeps = makeRenewalsDeps(tenantA.ctx.slug);
    const leaked = await runInTenant(tenantA.ctx, (tx) =>
      aDeps.memberRenewalFlagsRepo.readRenewalRemindersOptedOut(tx, tenantA.ctx.slug, bMemberUuid));
    expect(leaked).toBeNull(); // B's row invisible under A's context → null, NOT B's false
  });

  // Fix 2 (2026-06-07 follow-up) — DB-layer RLS probe for the preferred locale.
  // findPreferredLocaleInTx is ALSO tenant-predicate-free (`WHERE member_id = ?`
  // only, RLS-only). Under A's context, B's member row is RLS-hidden (0 rows),
  // so the adapter returns ok(null) and the use-case folds to {ok:true,
  // value:null}. The load-bearing invariant: the result is NEVER B's 'th' under
  // A's context. If A could read B's 'th', RLS+FORCE on `members` is broken.
  it('preferred locale — tenantA context cannot read tenantB member (RLS layer)', async () => {
    const r = await getMemberPreferredLocale(
      { tenant: tenantA.ctx, memberRepo: f3DrizzleMemberRepo }, asMemberId(bMemberUuid));
    // RLS-hidden member → use-case resolves to null (NOT B's 'th').
    expect(r.ok && r.value).toBeNull();
    expect(r.ok && r.value).not.toBe('th');
  });

  it('findByLinkedUserId: tenant B user looked up under tenant A returns not-found (cross-tenant)', async () => {
    const lookup = await buildMembersDeps(tenantA.ctx).memberRepo.findByLinkedUserId(tenantA.ctx, bUserId);
    expect(lookup.ok).toBe(false);
  });

  // --- Data-export isolation (seeded, non-vacuous) --------------------------

  // Fix 4 (2026-06-07 follow-up) — was vacuous (no export_jobs row seeded, so
  // both lists were empty and the cross-leak check passed trivially). Now each
  // tenant has ONE seeded `gdpr_member_archive` job, so this proves (a) A SEES
  // its own job (non-empty, correct subject + id field shape — never .memberId/
  // .jobId), and (b) a CROSS-TENANT probe under A's context for B's member id
  // returns EMPTY. listMemberDataExports → listRecentForSubject filters on an
  // explicit `tenant_id` + `subject_member_id` + `kind` predicate AND runs under
  // RLS+FORCE on `export_jobs`, so neither layer surfaces B's row to A.
  it('data-export list: tenantA sees its OWN job (subject/id field shape) and NOT tenantB job (isolation)', async () => {
    const aJobs = await listMemberDataExports(tenantA.ctx, aMemberUuid);
    // A sees its own seeded job (non-vacuous positive control).
    expect(aJobs.length).toBeGreaterThan(0);
    expect(aJobs.every((j) => j.subjectMemberId === aMemberUuid)).toBe(true);
    expect(aJobs.every((j) => typeof j.id === 'string')).toBe(true);
    // Cross-tenant probe: A's context for B's member → EMPTY (no leak).
    const bSeenUnderA = await listMemberDataExports(tenantA.ctx, bMemberUuid);
    expect(bSeenUnderA).toHaveLength(0);
    // Reciprocal own-tenant control: B sees its own job (correct subject + id).
    const bJobs = await listMemberDataExports(tenantB.ctx, bMemberUuid);
    expect(bJobs.length).toBeGreaterThan(0);
    expect(bJobs.every((j) => j.subjectMemberId === bMemberUuid)).toBe(true);
    // No id overlap between A's and B's jobs (defence-in-depth on the keying).
    const alphaIds = new Set(aJobs.map((j) => j.id));
    expect(bJobs.some((j) => alphaIds.has(j.id))).toBe(false);
  });
});
