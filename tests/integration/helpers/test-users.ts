/**
 * Integration-test user lifecycle helpers.
 *
 * Creates isolated test users with unique emails per test run, and
 * deletes them in teardown. Cascade cleans up sessions /
 * password_reset_tokens / invitations. `audit_log` rows REMAIN
 * because the append-only trigger (0001_audit_log_append_only.sql)
 * blocks DELETE — accepted pollution for MVP; future hardening should
 * run integration tests against a disposable Neon branch.
 *
 * Callers receive a plain object with:
 *   - userId: UserId brand
 *   - email: normalised EmailAddress
 *   - rawEmail: human-readable string
 *   - password: the plaintext password (for sign-in tests)
 *
 * Never use these helpers OUTSIDE the `tests/integration/**` tree.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { argon2Hasher } from '@/modules/auth/infrastructure/password/argon2-hasher';
import {
  asEmailAddress,
  asUserId,
  type EmailAddress,
  type UserId,
} from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';

export interface TestUser {
  readonly userId: UserId;
  readonly email: EmailAddress;
  readonly rawEmail: string;
  readonly password: string;
}

/**
 * Create a unique active test user with a known password.
 *
 * The email has the form `test-<timestamp>-<rand>@swecham.test` so
 * concurrent test runs don't collide. The password is
 * `Test-Password-<rand>!2026` which is guaranteed to pass the policy
 * (12+ chars, not common, not in HIBP for random tails).
 */
export async function createActiveTestUser(role: Role = 'admin'): Promise<TestUser> {
  const rand = Math.random().toString(36).slice(2, 10);
  const rawEmail = `test-${Date.now()}-${rand}@swecham.test`;
  const email = asEmailAddress(rawEmail);
  const password = `Test-Password-${rand}-xyZ!2026`;

  const hash = await argon2Hasher.hash(password);

  const rows = await db
    .insert(users)
    .values({
      email,
      role,
      status: 'active',
      passwordHash: hash,
      lastPasswordChangedAt: new Date(),
    })
    .returning();

  const row = rows[0];
  if (!row) throw new Error('createActiveTestUser: insert returned no row');

  return {
    userId: asUserId(row.id),
    email,
    rawEmail,
    password,
  };
}

/** Postgres SQLSTATE 23503 — foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = '23503';

function foreignKeyViolation(e: unknown): { constraint: string; table: string } | null {
  // drizzle wraps the driver error as `cause`; postgres.js exposes `code`
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object'; depth += 1) {
    const rec = cur as { code?: unknown; constraint_name?: unknown; table_name?: unknown; cause?: unknown };
    if (rec.code === FOREIGN_KEY_VIOLATION) {
      return {
        constraint: typeof rec.constraint_name === 'string' ? rec.constraint_name : '?',
        table: typeof rec.table_name === 'string' ? rec.table_name : '?',
      };
    }
    cur = rec.cause;
  }
  return null;
}

/**
 * Delete a test user. Sessions/tokens/invitations cascade; audit_log
 * rows are preserved by the append-only trigger.
 *
 * Eighteen FKs point at `users` and nine of them are RESTRICT / NO ACTION
 * (`invitations.invited_by_user_id`, `payments.actor_user_id`,
 * `invoices.draft_by_user_id`, `member_change_requests.decided_by_user_id`,
 * `membership_plans.created_by`, …), so a user that issued an invitation,
 * recorded a payment or decided a request cannot be deleted while that
 * row exists. This used to throw — and 116 teardowns wrapped the call in
 * `.catch(() => {})`, so the row silently stayed ACTIVE: by 2026-09-11 the
 * shared `dev` branch held 3,774 such admins and every per-reviewer
 * fan-out took minutes. Now a blocked delete DISABLES the user instead
 * (`listActiveUsersByRole` and every roster read filter on
 * `status = 'active'`), warns once with the blocking constraint so the
 * suite can be fixed at its source, and never throws for that case. Any
 * other error still propagates.
 */
export async function deleteTestUser(user: TestUser): Promise<void> {
  try {
    await db.delete(users).where(eq(users.id, user.userId));
  } catch (e) {
    const fk = foreignKeyViolation(e);
    if (!fk) throw e;
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, user.userId));
    console.warn(
      `[test-users] deleteTestUser: ${user.rawEmail} is referenced by ${fk.table} (${fk.constraint}) — ` +
        'disabled instead of deleted; delete that dependent in the suite teardown to remove the row',
    );
  }
}
