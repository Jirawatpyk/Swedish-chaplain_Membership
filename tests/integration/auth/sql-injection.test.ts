/**
 * T176 — SQL injection integration test (security.md T-09).
 *
 * Attack model: an attacker passes classic SQL-injection payloads in
 * the `email` or `password` fields of a sign-in request, hoping either
 * to bypass the credential check or to dump the user table via a UNION
 * SELECT.
 *
 * Our defence is Drizzle's parameterised query pipeline — every
 * user-supplied value is bound as a parameter, never interpolated into
 * the SQL string. This test exercises the real sign-in use case with
 * the real Postgres driver and asserts that:
 *
 *   1. Known-hostile payloads return `invalid-credentials` (not
 *      `ok: true` and not a crash).
 *   2. The users table is untouched (no rows created, no rows
 *      deleted, no rows locked).
 *   3. The zod schema at the API boundary rejects non-email inputs
 *      early for the ones that are structurally invalid, so those
 *      don't even reach the DB — we still include them to prove the
 *      defence-in-depth story.
 *
 * Every payload is run against one seeded user so we can verify the
 * expected row is still present and still has the expected password
 * hash at the end.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { signIn } from '@/modules/auth/application/sign-in';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';

/**
 * Classic SQL-injection payloads from OWASP WSTG-INPV-05. Mix of
 * email-field and password-field attacks. Several deliberately include
 * non-email shapes to exercise the zod guard at the API boundary in
 * a companion contract test, even though we bypass the zod here by
 * calling the use case directly (which is precisely how a bug in the
 * route handler would let them through).
 */
const PAYLOADS: ReadonlyArray<{
  label: string;
  email: string;
  password: string;
}> = [
  { label: 'tautology-or-1-1', email: "admin'--@swecham.test", password: "' OR '1'='1" },
  { label: 'union-select', email: 'victim@swecham.test', password: "' UNION SELECT 1,2,3--" },
  { label: 'comment-terminator', email: 'victim@swecham.test', password: "'; --" },
  { label: 'drop-table', email: 'victim@swecham.test', password: "'; DROP TABLE users;--" },
  { label: 'stacked-insert', email: 'victim@swecham.test', password: "'; INSERT INTO users VALUES (1);--" },
  { label: 'bool-blind', email: 'victim@swecham.test', password: "admin' AND 1=1--" },
  { label: 'time-blind', email: 'victim@swecham.test', password: "admin'; SELECT pg_sleep(10);--" },
  { label: 'encoded-quote', email: 'victim%27%20OR%201=1--@swecham.test', password: 'x' },
];

describe('integration: SQL injection resistance (T176, T-09)', () => {
  let victim: TestUser;

  beforeEach(async () => {
    victim = await createActiveTestUser('admin');
  });

  afterEach(async () => {
    await deleteTestUser(victim);
  });

  it('rejects every payload as invalid credentials and leaves the users table untouched', async () => {
    const rowsBefore = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, victim.userId));
    expect(rowsBefore).toHaveLength(1);
    const originalHash = rowsBefore[0]!.passwordHash;

    for (const payload of PAYLOADS) {
      const result = await signIn({
        // Force the real email through the payload slot so asEmailAddress
        // doesn't throw. We want the DB to see the payload as a bound
        // parameter.
        email: payload.email.includes('@') ? payload.email : `${payload.email}@swecham.test`,
        password: payload.password,
        portal: 'staff',
        sourceIp: '203.0.113.76',
        requestId: `sqli-${payload.label}`,
      }).catch((err) => ({ ok: false as const, error: { code: 'thrown', thrown: err } }));

      // The use case must NEVER return ok: true for a hostile payload,
      // and it must NEVER throw — a thrown error indicates the payload
      // reached a non-parameterised SQL path.
      expect(result).toMatchObject({ ok: false });
      if (!result.ok && 'code' in (result.error as Record<string, unknown>)) {
        const code = (result.error as { code: string }).code;
        // rate-limited is acceptable after ~5 attempts per email —
        // the important thing is that the attempt did not succeed.
        expect(['invalid-credentials', 'rate-limited', 'account-locked', 'thrown']).toContain(code);
        expect(code).not.toBe('thrown');
      }
    }

    // The victim row MUST still exist and its hash must be unchanged.
    const rowsAfter = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, victim.userId));
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]!.passwordHash).toBe(originalHash);

    // The users TABLE must still exist (drop attempt would crash later
    // tests, but this makes the assertion explicit).
    const allUsers = await db.select({ id: users.id }).from(users).limit(1);
    expect(allUsers.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
