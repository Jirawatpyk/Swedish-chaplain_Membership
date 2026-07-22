/**
 * Task 4 (`feat/members-portal-status`) — integration test for
 * `MemberRepo.findPendingInvitationsForPrimaryContacts`, the batched
 * directory-page read that feeds the portal-status badge
 * (`derivePortalState`, Task 3).
 *
 * Ports `findPendingInvitationsForMember` (single-member) to a
 * member-id-keyed batch read: for each supplied member, the FRESHEST
 * unconsumed invitation held by its PRIMARY contact. Carries the same
 * two load-bearing guards as the single-member method (see the port
 * doc on `findPendingInvitationsForPrimaryContacts` in
 * `member-repo.ts`):
 *   1. never-redeemed anti-join (Cluster 3, 2026-07-12)
 *   2. DISTINCT ON (member_id) + ORDER BY expires_at DESC
 *
 * Seeding helpers live in `../helpers/portal-seed.ts` — shared with
 * Tasks 9 and 13 on this branch; DO NOT re-copy them here.
 *
 * Live Neon Singapore against the same throwaway-tenant pattern as
 * `find-pending-invitations.test.ts`. No mocks — the cross-schema JOIN
 * behaves identically in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { MemberId } from '@/modules/members';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  addSecondaryContact,
  seedPortalInvitation,
  seedPortalMemberWithContact,
  seedPortalPlan,
} from '../helpers/portal-seed';

const PLAN_ID = 'test-portal-batch-plan';
const DAY = 86_400_000;

describe('findPendingInvitationsForPrimaryContacts', () => {
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let adminUser: TestUser;

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test');
    otherTenant = await createTestTenant('test');
    await seedPortalPlan(tenant.ctx.slug, adminUser.userId, PLAN_ID);
    await seedPortalPlan(otherTenant.ctx.slug, adminUser.userId, PLAN_ID);
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await otherTenant.cleanup().catch(() => {});
  });

  it('returns an empty array for an empty id list', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns the live invitation for an invited primary contact', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      expiresAt: new Date(Date.now() + 5 * DAY),
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0]?.memberId).toBe(memberId);
    // Must be a real Date instance — the consumer calls `.getTime()` on it
    // with no runtime guard.
    expect(res.value[0]?.expiresAt).toBeInstanceOf(Date);
    expect(res.value[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('EXCLUDES an already-active user holding a stale unconsumed row (anti-join)', async () => {
    // reissueInvitation mints a new row without invalidating the old one, so a
    // user who ACTIVATED keeps an unconsumed+expired row forever. Without the
    // anti-join this member is badged invite_expired permanently and never
    // leaves the needs-invite chip.
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
      consumedAt: null, // the stale row
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 3 * DAY),
      expiresAt: new Date(Date.now() + 4 * DAY),
      consumedAt: new Date(Date.now() - 2 * DAY), // they activated
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns exactly one row — the FRESHEST invitation — when several are unconsumed', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: invitee.userId,
    });
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - 2 * DAY),
    });
    const liveExpiry = new Date(Date.now() + 5 * DAY);
    await seedPortalInvitation(invitee.userId, adminUser.userId, {
      expiresAt: liveExpiry,
    });

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    // The LIVE one wins — otherwise the row derives to invite_expired and
    // contradicts the SQL filter, which excludes members holding a live invite.
    expect(res.value[0]?.expiresAt.getTime()).toBe(liveExpiry.getTime());
  });

  it('ignores a SECONDARY contact’s invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null, // primary is NOT invited
    });
    await addSecondaryContact(tenant, memberId as string, invitee.userId);
    await seedPortalInvitation(invitee.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('returns one row per member across a full 50-member page', async () => {
    // Guards against copying the single-member method's `.limit(50)`, which
    // would silently drop badges at exactly the directory page size.
    const ids: MemberId[] = [];
    for (let i = 0; i < 50; i++) {
      const invitee = await createActiveTestUser('member');
      const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
        linkedUserId: invitee.userId,
      });
      await seedPortalInvitation(invitee.userId, adminUser.userId);
      ids.push(memberId);
    }

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      ids,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(50);
  }, 120_000);

  it('does not leak another tenant’s invitation', async () => {
    const invitee = await createActiveTestUser('member');
    const { memberId } = await seedPortalMemberWithContact(
      otherTenant,
      PLAN_ID,
      { linkedUserId: invitee.userId },
    );
    await seedPortalInvitation(invitee.userId, adminUser.userId);

    // Query tenant A's repo with tenant B's member id.
    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [memberId],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual([]);
  });

  it('documents cross-tenant invitation visibility for a user linked in two tenants', async () => {
    // `invitations` is not tenant-scoped (no tenant column, no RLS), so a user
    // who is a contact in BOTH tenants carries the invitation state issued by
    // either one. This asserts CURRENT behaviour and pins it so a future change
    // is deliberate — see design doc §6 "cross-tenant state inference".
    const shared = await createActiveTestUser('member');
    const { memberId: aMember } = await seedPortalMemberWithContact(
      tenant,
      PLAN_ID,
      { linkedUserId: shared.userId },
    );
    await seedPortalMemberWithContact(otherTenant, PLAN_ID, {
      linkedUserId: shared.userId,
    });
    // The invitation is issued in the OTHER tenant's flow.
    await seedPortalInvitation(shared.userId, adminUser.userId);

    const deps = buildMembersDeps(tenant.ctx);
    const res = await deps.memberRepo.findPendingInvitationsForPrimaryContacts(
      tenant.ctx,
      [aMember],
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
  });

  it('rejects reading a non-granted invitations column under chamber_app', async () => {
    // The harness seeds via the OWNER-role `db` singleton, which reads
    // invitations.id freely; only runInTenant sets ROLE chamber_app. The
    // assertion MUST go through runInTenant or it proves nothing.
    //
    // Drizzle 0.45+ wraps the underlying Postgres error in a
    // `Failed query: ...` message and puts the real `PostgresError`
    // (with the SQLSTATE) on `.cause` — see `src/lib/db-errors.ts` and
    // `tests/integration/events/db-constraints.test.ts`. Asserting via
    // `toThrow(/42501/)` checks only the wrapper's top-level message and
    // never sees the code, so it would pass or fail for the wrong reason.
    await expect(
      runInTenant(tenant.ctx, async (tx) =>
        tx.select({ id: invitations.id }).from(invitations).limit(1),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
