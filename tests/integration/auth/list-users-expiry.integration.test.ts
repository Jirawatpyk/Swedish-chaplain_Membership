/**
 * Integration — `UserRepo.listWithFilter` invitation-expiry projection
 * (Staff Invitation Lifecycle, Task 5, live Neon).
 *
 * `/admin/users` shows a `pending` badge but gives no signal on whether
 * the underlying invitation is still live or has expired. This proves,
 * with REAL adapters (no mocks), that `listWithFilter` correlates each
 * `pending` row to its LATEST non-consumed `invitations.expires_at` via
 * a correlated subquery (RA-7 — kept OUT of the pure `UserAccount`
 * Domain type; `UserListRow = UserAccount & { invitationExpiresAt }` is
 * a repo-level projection):
 *
 *   1. A `pending` user with one live invitation → `invitationExpiresAt`
 *      equals that invitation's `expiresAt`.
 *   2. An `active` user (no invitation) → `invitationExpiresAt` is `null`.
 *   3. `consumed_at IS NULL` filtering: a user whose ONLY invitation is
 *      already consumed → `invitationExpiresAt` is `null` (a consumed
 *      token must never be surfaced as "live").
 *   4. "Latest wins" ordering: a user with TWO non-consumed invitations
 *      (the realistic shape after an admin "Resend" — `reissueInvitation`
 *      mints a fresh row without touching the old one, see
 *      reissue-invitation.ts) → `invitationExpiresAt` is the NEWER
 *      row's `expiresAt`, not the older one's.
 *
 * `users` / `invitations` are cross-tenant tables (no RLS, no
 * `tenant_id`) — mirrors the seeding pattern in
 * revoke-invitation.integration.test.ts, minus the tenant scaffolding.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users, invitations } from '@/modules/auth/infrastructure/db/schema';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

async function seedUser(opts: {
  email: string;
  status: 'pending' | 'active';
}): Promise<string> {
  const userId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: opts.email,
    role: 'member',
    status: opts.status,
    emailVerified: opts.status === 'active',
    requiresPasswordReset: false,
    failedSignInCount: 0,
    createdAt: new Date(),
  });
  return userId;
}

async function seedInvitation(opts: {
  userId: string;
  invitedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<void> {
  await db.insert(invitations).values({
    id: randomUUID(),
    userId: opts.userId,
    invitedByUserId: opts.invitedByUserId,
    intendedRole: 'member',
    createdAt: opts.createdAt,
    expiresAt: opts.expiresAt,
    consumedAt: opts.consumedAt ?? null,
  });
}

describe('UserRepo.listWithFilter — invitation expiry projection (Staff Invitation Lifecycle Task 5, live Neon)', () => {
  let admin: TestUser | undefined;
  const seededUserIds: string[] = [];

  afterEach(async () => {
    for (const id of seededUserIds.splice(0)) {
      await db.delete(users).where(eq(users.id, id)).catch(() => {});
    }
    if (admin) {
      await db.delete(users).where(eq(users.id, admin.userId)).catch(() => {});
      admin = undefined;
    }
  }, 30_000);

  async function getAdmin(): Promise<TestUser> {
    admin ??= await createActiveTestUser('admin');
    return admin;
  }

  it('pending user with one live invitation: invitationExpiresAt equals the invitation expiresAt', async () => {
    const inviter = await getAdmin();
    const sfx = randomUUID().slice(0, 8);
    const email = `expiry-live-${sfx}@swecham.test`;
    const userId = await seedUser({ email, status: 'pending' });
    seededUserIds.push(userId);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    await seedInvitation({
      userId,
      invitedByUserId: inviter.userId,
      createdAt: now,
      expiresAt,
    });

    const rows = await userRepo.listWithFilter({ q: email }, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invitationExpiresAt?.getTime()).toBe(expiresAt.getTime());
  }, 30_000);

  it('active user with no invitation: invitationExpiresAt is null', async () => {
    const sfx = randomUUID().slice(0, 8);
    const email = `expiry-active-${sfx}@swecham.test`;
    const userId = await seedUser({ email, status: 'active' });
    seededUserIds.push(userId);

    const rows = await userRepo.listWithFilter({ q: email }, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invitationExpiresAt).toBeNull();
  }, 30_000);

  it('consumed_at IS NULL filtering: a user whose only invitation is consumed gets null', async () => {
    const inviter = await getAdmin();
    const sfx = randomUUID().slice(0, 8);
    const email = `expiry-consumed-${sfx}@swecham.test`;
    // Status stays 'pending' here on purpose (not realistic post-redemption
    // state) so this test isolates the consumed_at filter from the status
    // filter — the repo method itself must not read `status` at all.
    const userId = await seedUser({ email, status: 'pending' });
    seededUserIds.push(userId);

    const now = new Date();
    await seedInvitation({
      userId,
      invitedByUserId: inviter.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      consumedAt: now,
    });

    const rows = await userRepo.listWithFilter({ q: email }, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invitationExpiresAt).toBeNull();
  }, 30_000);

  it('latest wins: two non-consumed invitations (post-resend shape) return the NEWER expiresAt', async () => {
    const inviter = await getAdmin();
    const sfx = randomUUID().slice(0, 8);
    const email = `expiry-latest-${sfx}@swecham.test`;
    const userId = await seedUser({ email, status: 'pending' });
    seededUserIds.push(userId);

    const older = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const olderExpiresAt = new Date(older.getTime() + 7 * 24 * 60 * 60 * 1000);
    await seedInvitation({
      userId,
      invitedByUserId: inviter.userId,
      createdAt: older,
      expiresAt: olderExpiresAt,
    });

    const newer = new Date();
    const newerExpiresAt = new Date(newer.getTime() + 7 * 24 * 60 * 60 * 1000);
    await seedInvitation({
      userId,
      invitedByUserId: inviter.userId,
      createdAt: newer,
      expiresAt: newerExpiresAt,
    });

    const rows = await userRepo.listWithFilter({ q: email }, 10, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.invitationExpiresAt?.getTime()).toBe(newerExpiresAt.getTime());
    expect(rows[0]?.invitationExpiresAt?.getTime()).not.toBe(olderExpiresAt.getTime());
  }, 30_000);
});
