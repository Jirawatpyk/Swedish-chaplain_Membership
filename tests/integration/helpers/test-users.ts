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

/**
 * Delete a test user. Sessions/tokens/invitations cascade; audit_log
 * rows are preserved by the append-only trigger.
 */
export async function deleteTestUser(user: TestUser): Promise<void> {
  await db.delete(users).where(eq(users.id, user.userId));
}
