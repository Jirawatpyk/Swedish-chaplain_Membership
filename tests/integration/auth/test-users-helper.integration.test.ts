/**
 * `tests/integration/helpers/test-users.ts` — the lifecycle helper itself.
 *
 * Why this exists (2026-09-11): `deleteTestUser` was a bare `db.delete(users)`.
 * Eighteen FKs point at `users`; nine of them are RESTRICT / NO ACTION
 * (`invitations.invited_by_user_id`, `payments.actor_user_id`,
 * `invoices.draft_by_user_id`, `member_change_requests.decided_by_user_id`,
 * `membership_plans.created_by`, …). Any test whose user issued an invitation,
 * recorded a payment or decided a change request therefore could NOT delete
 * its user — and 116 call sites do `deleteTestUser(u).catch(() => {})`, so
 * the failure was swallowed. The shared `dev` branch accumulated 3,774 ACTIVE
 * admin users named `test-<ts>-<rand>@swecham.test`; every per-reviewer
 * fan-out (F114's staff email) then took minutes.
 *
 * Contract pinned here:
 *   1. a user with NO dependents is deleted (cascade covers sessions / tokens /
 *      the invitation addressed TO them);
 *   2. a user that a RESTRICT dependent points at is NOT left active: the
 *      helper disables it (status = 'disabled') and returns — never throws,
 *      never leaves an active row behind;
 *   3. an unknown id is a no-op.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { invitations, users } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

const created: TestUser[] = [];
const invitationIds: string[] = [];

afterAll(async () => {
  for (const id of invitationIds) await db.delete(invitations).where(eq(invitations.id, id)).catch(() => {});
  for (const u of created) await db.delete(users).where(eq(users.id, u.userId)).catch(() => {});
});

async function statusOf(userId: string): Promise<string | null> {
  const rows = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  return rows[0]?.status ?? null;
}

describe('deleteTestUser (live Neon)', () => {
  it('deletes a user with no dependents (the invitation addressed TO them cascades)', async () => {
    const inviter = await createActiveTestUser('admin');
    const invitee = await createActiveTestUser('member');
    created.push(inviter, invitee);
    const invitationId = randomUUID();
    invitationIds.push(invitationId);
    await db.insert(invitations).values({
      id: invitationId,
      userId: invitee.userId,
      invitedByUserId: inviter.userId,
      intendedRole: 'member',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      consumedAt: null,
    });

    await deleteTestUser(invitee);
    expect(await statusOf(invitee.userId)).toBeNull();
    const left = await db.select({ id: invitations.id }).from(invitations).where(eq(invitations.id, invitationId));
    expect(left).toHaveLength(0); // ON DELETE CASCADE on invitations.user_id
  });

  it('a user that a RESTRICT dependent points at is DISABLED, not left active — and the call does not throw', async () => {
    const inviter = await createActiveTestUser('admin');
    const invitee = await createActiveTestUser('member');
    created.push(inviter, invitee);
    const invitationId = randomUUID();
    invitationIds.push(invitationId);
    await db.insert(invitations).values({
      id: invitationId,
      userId: invitee.userId,
      invitedByUserId: inviter.userId, // RESTRICT — the inviter cannot be deleted while this row exists
      intendedRole: 'member',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      consumedAt: null,
    });

    await expect(deleteTestUser(inviter)).resolves.toBeUndefined();
    expect(await statusOf(inviter.userId)).toBe('disabled');
  });

  it('an unknown id is a no-op', async () => {
    const ghost: TestUser = {
      userId: randomUUID() as TestUser['userId'],
      email: 'ghost@swecham.test' as TestUser['email'],
      rawEmail: 'ghost@swecham.test',
      password: 'x',
    };
    await expect(deleteTestUser(ghost)).resolves.toBeUndefined();
  });
});
