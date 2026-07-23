/**
 * Integration — bulkSendPortalInvite falls through to resendBouncedInvite
 * for expired (still-pending) invitations (Phase D, Task 13, live Neon).
 *
 * The needs-invite chip counts members whose portal invitation EXPIRED —
 * `invitations.consumed_at IS NULL AND expires_at < now`, linked user still
 * `pending`. Before this task, `invitePortal` returns `already_linked` for
 * these members (their `contacts.linked_user_id` is set) and the bulk action
 * bucketed them as `skipped`, promising work it refused to do.
 *
 * `resendBouncedInvite` (Cluster 3, 2026-07-12) already distinguishes a
 * dead-end pending invite from a genuinely active user — this test proves
 * the bulk action now calls it on the `already_linked` arm and buckets the
 * outcome correctly:
 *   - expired + still pending  → resent (new bucket)
 *   - linked + already ACTIVE  → skipped(already_linked)  (unchanged)
 *   - never invited            → invited                  (regression guard)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { bulkSendPortalInvite } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { users, invitations } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  seedPortalPlan,
  seedPortalMemberWithContact,
  seedPortalInvitation,
} from '../helpers/portal-seed';

const DAY = 86_400_000;
const PLAN_ID = 'test-bulk-invite-resend-plan';

/**
 * Seed a fresh 'pending' user by inserting directly (status='pending', no
 * password — the invitation has not yet been redeemed). `createActiveTestUser`
 * always seeds 'active', so a pending user needs a direct insert — mirrors
 * `invitation-bounced-edge-case.test.ts`'s `resendBouncedInvite` integration
 * seed.
 */
async function seedPendingUser(): Promise<{ userId: string; email: string }> {
  const userId = randomUUID();
  const email = `bulk-resend-pending-${randomUUID().slice(0, 8)}@swecham.test`;
  await db.insert(users).values({
    id: userId,
    email,
    role: 'member',
    status: 'pending',
    emailVerified: false,
    requiresPasswordReset: false,
    failedSignInCount: 0,
    createdAt: new Date(),
  });
  return { userId, email };
}

describe('bulkSendPortalInvite — expired-invitation re-send (Phase D, Task 13)', () => {
  let tenant: TestTenant;
  let adminUser: TestUser;
  const seededUserIds: string[] = [];

  function meta() {
    return {
      actorUserId: adminUser.userId,
      requestId: `req-${randomUUID().slice(0, 8)}`,
      sourceIp: '127.0.0.1',
    };
  }

  function deps(t: TestTenant) {
    const d = buildMembersDeps(t.ctx);
    return {
      tenant: d.tenant,
      memberRepo: d.memberRepo,
      contactRepo: d.contactRepo,
      createUser: d.createUser,
      deleteInvitedUser: d.deleteInvitedUser,
      // New in Phase D — all already provided by buildMembersDeps.
      reissueInvitation: d.reissueInvitation,
      userEmails: d.userEmails,
      audit: d.audit,
      clock: d.clock,
    };
  }

  beforeAll(async () => {
    adminUser = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, adminUser.userId, PLAN_ID);
  }, 60_000);

  afterAll(async () => {
    for (const userId of seededUserIds) {
      await db.delete(invitations).where(eq(invitations.userId, userId)).catch(() => {});
      await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    }
    await tenant?.cleanup().catch(() => {});
    await deleteTestUser(adminUser).catch(() => {});
  }, 60_000);

  it('re-sends instead of skipping when the invitation expired', async () => {
    const pendingUser = await seedPendingUser();
    seededUserIds.push(pendingUser.userId);
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: pendingUser.userId,
    });
    await seedPortalInvitation(pendingUser.userId, adminUser.userId, {
      createdAt: new Date(Date.now() - 9 * DAY),
      expiresAt: new Date(Date.now() - DAY),
    });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.resent).toBe(1);
    expect(res.value.counts.skipped).toBe(0);
    expect(res.value.counts.invited).toBe(0);
    expect(res.value.counts.failed).toBe(0);
    expect(res.value.resent[0]?.memberId).toBe(memberId as string);
  }, 60_000);

  it('still skips a member whose portal user is already active', async () => {
    const activeUser = await createActiveTestUser('member');
    seededUserIds.push(activeUser.userId);
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: activeUser.userId,
    });
    await seedPortalInvitation(activeUser.userId, adminUser.userId, {
      consumedAt: new Date(Date.now() - DAY),
    });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.resent).toBe(0);
    expect(res.value.skipped[0]?.reason).toBe('already_linked');
  }, 60_000);

  it('still invites a never-invited member through the normal path', async () => {
    // Regression: the fall-through must not disturb the happy path.
    const { memberId } = await seedPortalMemberWithContact(tenant, PLAN_ID, {
      linkedUserId: null,
    });

    const res = await bulkSendPortalInvite(
      { action: 'send_portal_invite', member_ids: [memberId as string] },
      meta(),
      deps(tenant),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts.invited).toBe(1);
    expect(res.value.counts.resent).toBe(0);
    // invitePortal minted a real F1 user for this member — track it for
    // teardown (it isn't in `seededUserIds` since we didn't pre-seed it).
    const invitedUserId = res.value.invited[0]?.userId;
    if (invitedUserId) seededUserIds.push(invitedUserId);
  }, 60_000);
});
