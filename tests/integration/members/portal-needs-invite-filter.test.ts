/**
 * Integration: the needs-invite directory filter (design doc 2026-07-23
 * §3.7, D5/D6) vs live Neon.
 *
 * `portalNeedsInvite` restricts `searchDirectoryWithCount` (and its
 * sibling `countMembersNeedingPortalInvite`) to members whose PRIMARY
 * contact either was never invited, or holds only expired unconsumed
 * invitations. Covers the same three load-bearing clauses as the batch
 * read (Task 4) plus the outer archived/erased exclusions:
 *   1. is_primary + removed_at IS NULL scoping (no drag-in from a
 *      secondary contact's state).
 *   2. "no live invitation" NOT EXISTS — a re-invite after an expiry
 *      must NOT match (agrees with the `invited` badge).
 *   3. "never redeemed" NOT EXISTS — an active user's stale unconsumed
 *      row must NOT match.
 *   Plus `members.status <> 'archived'` and the shared erased-exclusion
 *   from `buildDirectoryWhere`.
 *
 * Uses the shared Task 4 seed helpers (`tests/integration/helpers/
 * portal-seed.ts`) — never copy them inline.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';
import {
  seedPortalPlan,
  seedPortalMemberWithContact,
  seedPortalInvitation,
  addSecondaryContact,
} from '../helpers/portal-seed';

const PLAN_ID = 'test-needs-invite-plan';

const NOW = new Date();
const DAY = 86_400_000;

/** The filter every case starts from — mirrors what the page builds. */
function baseFilter(overrides: Record<string, unknown> = {}) {
  return {
    status: ['active', 'inactive'] as const,
    portalNeedsInvite: { now: NOW },
    limit: 50,
    offset: 0,
    ...overrides,
  };
}

/** Ids returned by the filtered search, for set-wise assertions. */
async function searchIds(tenant: TestTenant, filter: ReturnType<typeof baseFilter>) {
  const deps = buildMembersDeps(tenant.ctx);
  const res = await deps.memberRepo.searchDirectoryWithCount(tenant.ctx, filter as never);
  expect(res.ok).toBe(true);
  if (!res.ok) return [];
  return res.value.items.map((i) => i.member.memberId as string);
}

describe('needs-invite directory filter', () => {
  let tenant: TestTenant;
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    await seedPortalPlan(tenant.ctx.slug, adminUser.userId, PLAN_ID);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('matches a member whose primary contact was never invited', async () => {
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
    });
    expect(await searchIds(tenant, baseFilter())).toContain(memberId as string);
  });

  it('matches a member whose only unconsumed invitation has expired', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).toContain(memberId as string);
  });

  it('does NOT match a member holding a live invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match a member re-invited after an expiry (live + expired rows)', async () => {
    // A bare `EXISTS (expires_at <= now)` gets this wrong: the member holds an
    // expired row AND a live one. The badge says `invited`, so the filter must
    // agree — this is what the second NOT EXISTS clause is for.
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match an active user holding a stale unconsumed row', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 4 * DAY),
      consumedAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match on a SECONDARY contact’s state', async () => {
    const invitee = await createActiveTestUser('member');
    const activeUser = await createActiveTestUser('member');
    // Primary is fully active (consumed invite) → member does not need an invite.
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: activeUser.userId,
    });
    await seedPortalInvitation(activeUser.userId, adminUser.userId, {
      consumedAt: new Date(Date.now() - DAY),
    });
    // Secondary contact was never invited — must NOT drag the member in.
    await addSecondaryContact(tenant, memberId as string, invitee.userId);
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('does NOT match a member with no primary contact', async () => {
    const memberId = randomUUID();
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `NoContactCo ${memberId.slice(0, 6)}`,
        country: 'TH',
        planId: PLAN_ID,
        planYear: 2026,
        registrationDate: new Date().toISOString().slice(0, 10),
        registrationFeePaid: false,
        status: 'active',
        archivedAt: null,
      });
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId);
  });

  it('excludes archived members even when status=archived is requested', async () => {
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, memberId as string));
    });
    const ids = await searchIds(
      tenant,
      baseFilter({ status: ['active', 'inactive', 'archived'] }),
    );
    // The bulk action skips archived members unconditionally, so counting them
    // would promise work that cannot be done.
    expect(ids).not.toContain(memberId as string);
  });

  it('excludes GDPR-erased members', async () => {
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, memberId as string));
    });
    expect(await searchIds(tenant, baseFilter())).not.toContain(memberId as string);
  });

  it('count equals the filtered row count under a compound filter', async () => {
    // Count and the visible list currently share ONE `buildDirectoryWhere`
    // (Task 8), so they cannot drift today. This test is the regression guard
    // that keeps it that way: if the count is ever given its own WHERE assembly
    // and drops the erased / archived / q predicate, a decoy row seeded below
    // inflates the count and this assertion (count ≠ rows) catches it.
    const marker = `CompoundCo-${randomUUID().slice(0, 8)}`;
    const matching: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
        linkedUserId: null,
        companyName: `${marker} ${i}`,
      });
      matching.push(memberId as string);
    }
    // Decoys carrying the same marker: one archived, one erased.
    const { memberId: archived } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
      companyName: `${marker} archived`,
    });
    const { memberId: erased } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
      companyName: `${marker} erased`,
    });
    await runInTenant(tenant.ctx, async (tx) => {
      await tx
        .update(members)
        .set({ status: 'archived', archivedAt: new Date() })
        .where(eq(members.memberId, archived as string));
      await tx
        .update(members)
        .set({ erasedAt: new Date() })
        .where(eq(members.memberId, erased as string));
    });
    // A decoy that does NOT match `q` at all.
    await seedPortalMemberWithContact(tenant, PLAN_ID, { linkedUserId: null });

    const filter = baseFilter({ q: marker });
    const deps = buildMembersDeps(tenant.ctx);
    const [count, page] = await Promise.all([
      deps.memberRepo.countMembersNeedingPortalInvite(tenant.ctx, filter as never),
      deps.memberRepo.searchDirectoryWithCount(tenant.ctx, filter as never),
    ]);
    expect(count.ok).toBe(true);
    expect(page.ok).toBe(true);
    if (!count.ok || !page.ok) return;
    expect(count.value).toBe(2);
    expect(page.value.total).toBe(2);
    expect(page.value.items.map((i) => i.member.memberId as string).sort()).toEqual(
      [...matching].sort(),
    );
  }, 60_000);
});
