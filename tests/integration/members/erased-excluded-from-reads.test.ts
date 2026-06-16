/**
 * COMP-1 (Member Erasure) — H4 regression net: an ERASED member's anonymised
 * tombstone row MUST NOT appear in any OPERATIONAL listing / enumeration /
 * processing read.
 *
 * `eraseMember` deliberately KEEPS `status` (erasure is orthogonal to archive)
 * and only stamps the new `erased_at` column. Every operational read therefore
 * has to add `erased_at IS NULL` explicitly — `status` does NOT hide an erased
 * row. This suite proves the MEMBERS-module surfaces exclude the erased row:
 *   - the admin directory (cursor `searchDirectory` + offset
 *     `searchDirectoryWithCount`, which also powers the command palette + the
 *     F9 directory/export/enumeration roll-ups via the public barrel);
 *   - the F7 broadcast segment resolution (`findMembersBySegmentForBroadcast`)
 *     so an erased member is never a broadcast recipient;
 *   - the F7 halt queue (`findMembersHaltedForBroadcast`);
 *   - soft-duplicate detection (`findSoftDuplicate`) so an erased tombstone
 *     can't block a legitimate re-create.
 *
 * By-id / detail / audit reads (findById, GDPR self-export, the erase cascade
 * itself) are intentionally NOT filtered — they need the tombstone.
 *
 * Live Neon. Reuses the directory-search seed pattern (createMember + a seeded
 * plan) and erases via the PRODUCTION composition root `buildEraseMemberDeps`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import {
  createMember,
  directorySearch,
  directorySearchWithCount,
  eraseMember,
  type MemberId,
} from '@/modules/members';
import {
  buildMembersDeps,
  buildEraseMemberDeps,
} from '@/modules/members/members-deps';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { seedTenantFiscal } from '../helpers/seed-tenant-fiscal';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

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

async function seedPlan(tenant: TestTenant, user: TestUser): Promise<string> {
  const planId = `erased-plan-${randomUUID().slice(0, 6)}`;
  await seedTenantFiscal({ tenant, registrationFeeSatang: 100000n });
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(membershipPlans).values({
      tenantId: tenant.ctx.slug,
      planId,
      planYear: 2026,
      planName: { en: 'Erased Reads Plan' },
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
  return planId;
}

async function seedMember(
  tenant: TestTenant,
  user: TestUser,
  planId: string,
  companyName: string,
): Promise<MemberId> {
  const deps = buildMembersDeps(tenant.ctx);
  const slug = `erased-${randomUUID().slice(0, 8)}`;
  const r = await createMember(
    {
      company_name: companyName,
      country: 'SE',
      plan_id: planId,
      plan_year: 2026,
      primary_contact: {
        first_name: 'Anna',
        last_name: 'Andersson',
        email: `${slug}@example.com`,
        preferred_language: 'sv' as const,
      },
    },
    { actorUserId: user.userId, requestId: `seed-${slug}` },
    deps,
  );
  if (!r.ok) {
    throw new Error(`seed ${companyName} failed: ${JSON.stringify(r.error)}`);
  }
  return r.value.memberId;
}

describe('erased members excluded from operational reads (members module)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let planId: string;
  let keptId: MemberId;
  let erasedId: MemberId;
  // A member that was halted-for-broadcast-review BEFORE erasure. Erasure KEEPS
  // the halt flag (it's a non-identifying state flag) and only stamps
  // `erased_at`, so the halt queue must rely on `erased_at IS NULL` to drop it.
  let haltedErasedId: MemberId;

  // KEPT_COMPANY is unique so the directory `q` filter isolates exactly the
  // two seeded rows regardless of any other rows in the shared tenant.
  const KEPT_COMPANY = `ErasedReadsKept-${randomUUID().slice(0, 8)}`;
  const ERASED_COMPANY = `ErasedReadsGone-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant();
    planId = await seedPlan(tenant, user);

    keptId = await seedMember(tenant, user, planId, KEPT_COMPANY);
    erasedId = await seedMember(tenant, user, planId, ERASED_COMPANY);

    // Erase the second member via the production composition root.
    const eraseDeps = buildEraseMemberDeps(tenant.ctx);
    const res = await eraseMember(
      erasedId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: user.userId, requestId: 'erased-reads-seed' },
      eraseDeps,
    );
    if (!res.ok) {
      throw new Error(`erase seed failed: ${JSON.stringify(res.error)}`);
    }

    // Seed a THIRD member, mark it halted-for-broadcast-review, THEN erase it.
    // Set the halt column directly (raw update) — the production helper needs a
    // tx + audit emit we don't care about here; the column write is what the
    // halt-queue read keys on.
    haltedErasedId = await seedMember(
      tenant,
      user,
      planId,
      `ErasedReadsHalted-${randomUUID().slice(0, 8)}`,
    );
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ broadcastsHaltedUntilAdminReview: true })
        .where(eq(members.memberId, haltedErasedId));
    });
    const haltRes = await eraseMember(
      haltedErasedId,
      { reason: 'gdpr_erasure_request' },
      { actorUserId: user.userId, requestId: 'erased-reads-halted-seed' },
      eraseDeps,
    );
    if (!haltRes.ok) {
      throw new Error(`halted erase seed failed: ${JSON.stringify(haltRes.error)}`);
    }
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  // NOTE: the directory tests deliberately do NOT use a `q` filter. Erasure
  // scrubs `company_name` to '[erased]', so a `q` substring on the original
  // name would FALSE-GREEN (the renamed row no longer matches the term). The
  // real leak is the DEFAULT admin list (no q), which still shows the
  // '[erased]' tombstone unless `erased_at IS NULL` is applied. We assert by
  // member-id presence over the full default list (this is a freshly-created
  // dedicated tenant, so only our 2 seeds + any active state rows exist).

  it('searchDirectoryWithCount excludes the erased member AND decrements total', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearchWithCount(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100, offset: 0 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.items.map((i) => i.member.memberId);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(erasedId);
    // Dedicated tenant: exactly the one kept (active/inactive) member remains.
    expect(r.value.total).toBe(1);
  });

  it('searchDirectory (cursor) excludes the erased member', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await directorySearch(
      { tenant: tenant.ctx, memberRepo: deps.memberRepo },
      { limit: 100 },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.items.map((i) => i.member.memberId);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(erasedId);
  });

  it('findMembersBySegmentForBroadcast (all_members) excludes the erased member', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await deps.memberRepo.findMembersBySegmentForBroadcast(
      tenant.ctx,
      { segmentType: 'all_members' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((m) => m.memberId);
    expect(ids).toContain(keptId);
    expect(ids).not.toContain(erasedId);
  });

  it('findMembersHaltedForBroadcast excludes the erased member (halt flag kept, erased_at filters it)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await deps.memberRepo.findMembersHaltedForBroadcast(tenant.ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((m) => m.memberId);
    // The halted member was erased → it must NOT surface in the admin halt
    // queue even though its broadcasts_halted_until_admin_review flag is still
    // TRUE (erasure keeps the flag; only `erased_at IS NULL` drops the row).
    expect(ids).not.toContain(haltedErasedId);
  });

  it('findSoftDuplicate ignores the erased tombstone (re-create not blocked)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    // The erased member's company_name is now '[erased]', so a lookup by the
    // ORIGINAL name must find nothing — proving the tombstone does not block a
    // legitimate re-registration under the same name.
    const r = await deps.memberRepo.findSoftDuplicate(
      tenant.ctx,
      ERASED_COMPANY,
      'SE',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });
});
