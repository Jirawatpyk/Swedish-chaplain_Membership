/**
 * Integration — `pruneExpiredInvitations` use case (Staff Invitation
 * Lifecycle, Task 6, live Neon).
 *
 * Proves, with REAL adapters (no mocks):
 *
 *   1. GRACE WINDOW: a pending user whose ONLY invitation expired well
 *      BEYOND the grace cutoff (40d ago, 30d grace) is deleted; one whose
 *      only invitation expired WITHIN the grace window (10d ago) is kept.
 *
 *   2. RA-4 (design-review amendment, 2026-07-18) TWO-TOKEN SAFETY: Resend
 *      (`reissueInvitation`, Task 1) mints a NEW `invitations` row WITHOUT
 *      deleting the old one, so a single pending user can carry BOTH a
 *      long-dead original token AND a fresh, still-valid one. A pending
 *      user with an OLD invitation expired 40d ago AND a FRESH invitation
 *      expiring in the future MUST survive — pruning them would destroy
 *      their still-valid activation link.
 *
 *   3. AUDIT: exactly one `invitation_expired` audit row is appended, for
 *      the pruned user only.
 *
 *   4. OUTBOX CROSS-TENANT CLEANUP: a pruned user's email had a queued
 *      `pending` `member_invitation` outbox row in TWO different tenants
 *      (plausible — one person invited to multiple chambers). BOTH are
 *      deleted, because the user is gone system-wide (no single tenant to
 *      scope the cleanup to — see `deleteInviteOutboxByEmailAllTenantsInTx`
 *      JSDoc). A non-`member_invitation` outbox row on the SAME email
 *      survives (notification-type scoping preserved, same as
 *      `revokeInvitation`).
 *
 * Mirrors the seeding pattern in
 * tests/integration/auth/revoke-invitation.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { pruneExpiredInvitations } from '@/modules/auth';
import {
  auditLog,
  invitations,
  notificationsOutbox,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, type TestUser } from '../helpers/test-users';

const DAY_MS = 86_400_000;

async function seedPendingUser(email: string): Promise<string> {
  const rows = await db
    .insert(users)
    .values({
      email,
      role: 'member',
      status: 'pending',
      emailVerified: false,
      requiresPasswordReset: false,
      failedSignInCount: 0,
      createdAt: new Date(),
    })
    .returning({ id: users.id });
  const row = rows[0];
  if (!row) throw new Error('seedPendingUser: insert returned no row');
  return row.id;
}

async function seedInvitation(opts: {
  userId: string;
  invitedByUserId: string;
  expiresAt: Date;
  consumedAt?: Date | null;
}): Promise<void> {
  await db.insert(invitations).values({
    id: randomUUID(),
    userId: opts.userId,
    invitedByUserId: opts.invitedByUserId,
    intendedRole: 'member',
    createdAt: new Date(opts.expiresAt.getTime() - 7 * DAY_MS),
    expiresAt: opts.expiresAt,
    consumedAt: opts.consumedAt ?? null,
  });
}

async function seedOutboxRow(opts: {
  tenantId: string;
  toEmail: string;
  notificationType: 'member_invitation' | 'email_verification';
  status?: 'pending' | 'sent';
}): Promise<void> {
  await db.insert(notificationsOutbox).values({
    tenantId: opts.tenantId,
    notificationType: opts.notificationType,
    toEmail: opts.toEmail.toLowerCase(),
    locale: 'en',
    contextData: { token: 'irrelevant-test-token', role: 'member' },
    status: opts.status ?? 'pending',
  });
}

async function userExists(id: string): Promise<boolean> {
  const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return rows.length > 0;
}

async function countOutbox(tenantId: string, toEmail: string): Promise<number> {
  const rows = await db
    .select({ id: notificationsOutbox.id })
    .from(notificationsOutbox)
    .where(
      and(
        eq(notificationsOutbox.tenantId, tenantId),
        eq(notificationsOutbox.toEmail, toEmail.toLowerCase()),
      ),
    );
  return rows.length;
}

describe('pruneExpiredInvitations — integration (Staff Invitation Lifecycle Task 6, live Neon)', () => {
  let admin: TestUser;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
  }, 60_000);

  afterAll(async () => {
    await db.delete(users).where(eq(users.id, admin.userId)).catch(() => {});
  }, 30_000);

  it('prunes ONLY the pending user with no live invitation (grace window + RA-4 two-token safety), audits it once, and drops its cross-tenant queued outbox rows', async () => {
    const sfx = randomUUID().slice(0, 8);
    const now = new Date();
    const requestId = `it-prune-${sfx}`;
    const tenantA = `test-prune-a-${sfx}`;
    const tenantB = `test-prune-b-${sfx}`;

    const emailA = `prune-a-${sfx}@swecham.test`; // expired 40d ago, no other token — PRUNE
    const emailB = `prune-b-${sfx}@swecham.test`; // expired 10d ago — inside 30d grace — KEEP
    const emailC = `prune-c-${sfx}@swecham.test`; // RA-4: old 40d-expired + fresh future token — KEEP

    let userIdA: string | undefined;
    let userIdB: string | undefined;
    let userIdC: string | undefined;

    try {
      userIdA = await seedPendingUser(emailA);
      userIdB = await seedPendingUser(emailB);
      userIdC = await seedPendingUser(emailC);

      // A: single invitation, expired well beyond the 30d grace cutoff.
      await seedInvitation({
        userId: userIdA,
        invitedByUserId: admin.userId,
        expiresAt: new Date(now.getTime() - 40 * DAY_MS),
      });

      // B: single invitation, expired but still INSIDE the grace window.
      await seedInvitation({
        userId: userIdB,
        invitedByUserId: admin.userId,
        expiresAt: new Date(now.getTime() - 10 * DAY_MS),
      });

      // C: RA-4 two-token case — an old dead token AND a fresh live one.
      await seedInvitation({
        userId: userIdC,
        invitedByUserId: admin.userId,
        expiresAt: new Date(now.getTime() - 40 * DAY_MS),
      });
      await seedInvitation({
        userId: userIdC,
        invitedByUserId: admin.userId,
        expiresAt: new Date(now.getTime() + 7 * DAY_MS),
      });

      // Cross-tenant queued invites for A's email — both must be cleaned
      // up because A is pruned (gone system-wide).
      await seedOutboxRow({ tenantId: tenantA, toEmail: emailA, notificationType: 'member_invitation' });
      await seedOutboxRow({ tenantId: tenantB, toEmail: emailA, notificationType: 'member_invitation' });
      // Different notification type, same email — must SURVIVE (type scoping).
      await seedOutboxRow({ tenantId: tenantA, toEmail: emailA, notificationType: 'email_verification' });

      const result = await pruneExpiredInvitations({ now, graceDays: 30, requestId });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // NOT `toBe(1)`: `pruneExpiredInvitations` is a GLOBAL sweep by
      // design (no tenant/email scope in its input — see the use case's
      // header comment), and this test runs against the shared `dev`
      // Neon branch, which — confirmed by direct inspection while
      // debugging this test — carries ~50 leftover `pending` users from
      // OTHER integration suites' incomplete cleanup (e.g. repeated
      // `resend-*@example.com` fixtures), some of which legitimately
      // satisfy the same "no live invitation" criteria as our seeded
      // user A. A `prunedCount === 1` assertion would be flaky: it
      // depends on how much unrelated debris happens to exist in the
      // shared DB at the moment this test runs. The floor assertion
      // below only confirms the counter isn't silently stuck at 0; the
      // real assertions are the per-user existence + per-user audit-row
      // checks further down, which are exact regardless of debris.
      expect(result.value.prunedCount).toBeGreaterThanOrEqual(1);

      // A is gone; B and C survive.
      expect(await userExists(userIdA)).toBe(false);
      expect(await userExists(userIdB)).toBe(true);
      expect(await userExists(userIdC)).toBe(true);

      // A was audited as invitation_expired; B and C were NOT — checked
      // by targetUserId, not by counting ALL rows for this requestId
      // (other incidentally-pruned debris rows share the same
      // requestId, since it is one value threaded through the whole
      // batch — see header comment above).
      const auditRows = await db
        .select({ eventType: auditLog.eventType, targetUserId: auditLog.targetUserId })
        .from(auditLog)
        .where(eq(auditLog.requestId, requestId));
      const aAudited = auditRows.find(
        (r) => r.eventType === 'invitation_expired' && r.targetUserId === userIdA,
      );
      expect(aAudited).toBeDefined();
      const bOrCAudited = auditRows.some(
        (r) =>
          r.eventType === 'invitation_expired' &&
          (r.targetUserId === userIdB || r.targetUserId === userIdC),
      );
      expect(bOrCAudited).toBe(false);

      // Both cross-tenant pending member_invitation outbox rows for A's
      // email are gone; the email_verification row on the same email
      // survives.
      expect(await countOutbox(tenantA, emailA)).toBe(1); // only email_verification left
      expect(await countOutbox(tenantB, emailA)).toBe(0);
    } finally {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.toEmail, emailA.toLowerCase())).catch(() => {});
      await db.delete(auditLog).where(eq(auditLog.requestId, requestId)).catch(() => {});
      if (userIdA) await db.delete(users).where(eq(users.id, userIdA)).catch(() => {});
      if (userIdB) await db.delete(users).where(eq(users.id, userIdB)).catch(() => {});
      if (userIdC) await db.delete(users).where(eq(users.id, userIdC)).catch(() => {});
    }
  }, 60_000);
});
