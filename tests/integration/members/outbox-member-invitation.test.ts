/**
 * Integration test — verify `createUser` inserts a correctly-shaped
 * `notifications_outbox` row for the F1 invitation flow (T049 end-to-
 * end coverage).
 *
 * Uses `defaultCreateUserDeps` — real `enqueueInvitation` impl against
 * live Neon — no stubs for the enqueue path. Asserts the row the
 * outbox dispatcher (`/api/cron/outbox-dispatch`) will later consume:
 *
 *   notification_type = 'member_invitation'
 *   context_data.token = <invitation.id>
 *   context_data.role  = 'member' | 'manager' | 'admin'
 *   tenant_id          = 'swecham' (Round-3 follow-up: pre-MTA F1 used
 *                        null since the dispatcher served every tenant;
 *                        migration 0098 enabled FORCE RLS + NOT NULL,
 *                        so every invitation now carries the inviter's
 *                        chamber slug).
 *   status             = 'pending'
 *   attempts           = 0
 *
 * Covers the previously untested path where `auth-deps.ts`
 * `enqueueInvitation` inserts to the table — prior integration tests
 * stubbed the enqueue via `stubEnqueueInvitation`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { sha256Hex } from '@/lib/crypto';
import {
  invitations,
  notificationsOutbox,
  users,
} from '@/modules/auth/infrastructure/db/schema';
import {
  createUser,
  defaultCreateUserDeps,
} from '@/modules/auth/application/create-user';
import { asTenantSlug } from '@/modules/tenants/domain/tenant-slug';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

describe('integration: createUser enqueues outbox row with correct shape', () => {
  let admin: TestUser;
  let inviteeEmail: string;
  const createdOutboxIds: string[] = [];

  beforeEach(async () => {
    admin = await createActiveTestUser('admin');
    inviteeEmail = `test-outbox-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@swecham.test`;
  });

  afterEach(async () => {
    // Clean up outbox rows first (no FK to users, but tidy).
    for (const id of createdOutboxIds) {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.id, id));
    }
    createdOutboxIds.length = 0;
    // Invitations FK-cascade from users.
    await db.delete(users).where(eq(users.email, inviteeEmail));
    await deleteTestUser(admin);
  });

  it('inserts member_invitation row with token + role + inviter tenantId', async () => {
    const requestId = `it-outbox-${Date.now()}`;

    const result = await createUser(
      {
        email: inviteeEmail,
        role: 'manager',
        displayName: 'Outbox Test Manager',
        actorUserId: admin.userId,
        sourceIp: '203.0.113.20',
        requestId,
        locale: 'th',
        tenantId: asTenantSlug('swecham'),
      },
      defaultCreateUserDeps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { user: pendingUser, invitationId } = result.value;

    // Confirm a matching outbox row exists.
    const rows = await db
      .select()
      .from(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.toEmail, inviteeEmail.toLowerCase()),
          eq(notificationsOutbox.notificationType, 'member_invitation'),
          eq(notificationsOutbox.tenantId, 'swecham'),
        ),
      );

    expect(rows.length).toBe(1);
    const row = rows[0]!;
    createdOutboxIds.push(row.id);

    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.locale).toBe('th');
    expect(row.tenantId).toBe('swecham');

    const ctx = row.contextData as Record<string, unknown>;
    // Token-hashing contract (create-user.ts §3): the outbox carries the
    // PLAINTEXT token (emailed in the URL) while the persisted invitation id
    // is its sha256 hash. So the plaintext must hash to invitationId — they
    // are intentionally NOT equal (a DB leak must not expose usable tokens).
    expect(sha256Hex(ctx.token as string)).toBe(invitationId);
    expect(ctx.role).toBe('manager');

    // Belt-and-braces: confirm the invitation row the token points at
    // exists and matches the pending user we just created.
    const inv = await db
      .select()
      .from(invitations)
      .where(eq(invitations.id, invitationId));
    expect(inv.length).toBe(1);
    expect(inv[0]!.userId).toBe(pendingUser.id);
  });

  it('preserves role across the three supported values', async () => {
    const roles = ['admin', 'manager', 'member'] as const;
    for (const role of roles) {
      const email = `test-outbox-role-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@swecham.test`;
      const result = await createUser(
        {
          email,
          role,
          actorUserId: admin.userId,
          sourceIp: '203.0.113.21',
          requestId: `it-outbox-role-${role}`,
          tenantId: asTenantSlug('swecham'),
        },
        defaultCreateUserDeps,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const rows = await db
        .select()
        .from(notificationsOutbox)
        .where(
          and(
            eq(notificationsOutbox.toEmail, email.toLowerCase()),
            eq(notificationsOutbox.notificationType, 'member_invitation'),
          ),
        );
      expect(rows.length).toBe(1);
      const ctx = rows[0]!.contextData as Record<string, unknown>;
      expect(ctx.role).toBe(role);
      createdOutboxIds.push(rows[0]!.id);

      // Clean up per-iteration user to avoid FK blockers on next loop.
      await db.delete(users).where(eq(users.email, email));
    }
  });
});
