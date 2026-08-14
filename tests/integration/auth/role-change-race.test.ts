/**
 * T116 — Concurrent last-admin race integration test (FR-011, US4 edge).
 *
 * REWRITTEN 2026-08-14 (016 post-ship review): the original raced two
 * plain-`admin` rows — a population migration 0288 deliberately
 * UN-protects — so every assertion had become vacuous (observed on
 * shared dev: baseline=183 leftover admin rows; on a clean DB the test
 * would have failed its own conditional assertions). The protected
 * population is `super_admin` alone, and the write-skew the guard must
 * stop is CROSS-SESSION: two sessions each removing one of the last two
 * active super_admins, where each trigger COUNT (READ COMMITTED)
 * excludes its own OLD.id and cannot see the other's uncommitted
 * UPDATE. Migration 0289 closes that with a pg_advisory_xact_lock taken
 * before the COUNT.
 *
 * Three tests, all non-destructive on shared dev:
 *
 *   1. **Realistic race (invariant)** — Promise.all of disable+demote on
 *      two seeded super_admins. At least one active super_admin must
 *      survive; if baseline was exactly 2, both succeeding is a guard
 *      failure; a lone failure must be `last-admin-protection`.
 *   2. **Serialization probe (deterministic)** — while a qualifying
 *      removal is uncommitted in an open transaction, the guard's
 *      advisory lock must be held (pg_try_advisory_xact_lock from a
 *      second connection returns false), and free again after rollback.
 *      This is the mechanism that makes the second session's COUNT see
 *      the first session's commit.
 *   3. **Refusal at zero (deterministic)** — inside ONE transaction,
 *      walk the live population down to two seeded super_admins, demote
 *      both; the second demotion must be refused by the REAL trigger
 *      with ERRCODE 23514 + 'last-admin-protection'. ROLLBACK restores
 *      everything (crash-safe: an uncommitted tx auto-rolls back).
 *
 * Shared-dev caveat: test 3 assumes no concurrent session INSERTS a new
 * active super_admin mid-transaction (would flake the refusal). Re-run
 * on flake per the shared-Neon policy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, notInArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/modules/auth/infrastructure/db/schema';
import { disableUser } from '@/modules/auth/application/disable-user';
import { changeRole } from '@/modules/auth/application/change-role';
import { isLastAdminTriggerError } from '@/lib/db-errors';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const GUARD_LOCK_PROBE = sql`SELECT pg_try_advisory_xact_lock(hashtextextended('auth:last_admin_guard', 0)) AS got`;

async function countActiveSuperAdmins(): Promise<number> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'super_admin'), eq(users.status, 'active')));
  return rows.length;
}

describe('integration: concurrent last-admin race (T116, FR-011)', () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeEach(async () => {
    alice = await createActiveTestUser('super_admin');
    bob = await createActiveTestUser('super_admin');
  });

  afterEach(async () => {
    // Demote to plain admin (unprotected) so the hard delete below
    // cannot trip the guard. The demotion itself is a qualifying
    // removal and passes while another active super_admin remains
    // (the other seed, or the bootstrap super_admin). On a pathological
    // dev DB with no other super_admin the demote+delete both refuse —
    // warn and leave the row rather than fight the invariant.
    for (const u of [alice, bob]) {
      try {
        await db
          .update(users)
          .set({ status: 'active', role: 'admin' })
          .where(eq(users.id, u.userId));
      } catch {
        console.warn(`  cleanup: could not demote ${u.rawEmail} (guard refused)`);
      }
      try {
        await deleteTestUser(u);
      } catch {
        console.warn(`  cleanup: could not delete ${u.rawEmail} — leaked test row`);
      }
    }
  });

  it(
    'two concurrent super_admin-removals never leave zero super_admins (invariant)',
    async () => {
      const baselineCount = await countActiveSuperAdmins();
      expect(baselineCount).toBeGreaterThanOrEqual(2);

      const [disableResult, roleResult] = await Promise.all([
        disableUser({
          targetUserId: alice.userId,
          actorUserId: bob.userId,
          sourceIp: '203.0.113.80',
          requestId: 'race-disable',
        }),
        changeRole({
          targetUserId: bob.userId,
          newRole: 'manager',
          actorUserId: alice.userId,
          sourceIp: '203.0.113.81',
          requestId: 'race-role',
        }),
      ]);

      const disableOk = disableResult.ok;
      const roleOk = roleResult.ok;
      const disableErr = disableResult.ok ? null : disableResult.error.code;
      const roleErr = roleResult.ok ? null : roleResult.error.code;

      console.log(
        `  race: baseline=${baselineCount} disable=${disableOk ? 'ok' : disableErr} role=${roleOk ? 'ok' : roleErr}`,
      );

      // CORE INVARIANT: at least one active super_admin survives.
      expect(await countActiveSuperAdmins()).toBeGreaterThanOrEqual(1);

      // If both mutations succeeded, baseline must have been ≥ 3 for
      // the guarantee to hold. (baseline - 2 ≥ 1 → baseline ≥ 3.)
      if (disableOk && roleOk) {
        expect(baselineCount).toBeGreaterThanOrEqual(3);
      }
      // If only one succeeded, the other MUST have failed with
      // last-admin-protection (not some other error).
      if (disableOk && !roleOk) {
        expect(roleErr).toBe('last-admin-protection');
      }
      if (!disableOk && roleOk) {
        expect(disableErr).toBe('last-admin-protection');
      }
      // Both failing is also acceptable (edge: both hit the guard
      // before either committed). Only "both succeed with baseline=2"
      // is a real failure, which is already caught above.
    },
    60_000,
  );

  it(
    'a qualifying removal holds the guard advisory lock until tx end (0289 serialization)',
    async () => {
      const sentinel = new Error('rollback-probe');
      let lockFreeDuringRemoval: boolean | null = null;

      try {
        await db.transaction(async (tx) => {
          // Qualifying removal: active super_admin → admin. The 0289
          // trigger must take pg_advisory_xact_lock BEFORE its COUNT.
          await tx
            .update(users)
            .set({ role: 'admin' })
            .where(eq(users.id, alice.userId));

          // Probe from a SECOND pool connection (autocommit xact — if
          // it did acquire the lock it would release it instantly).
          const rows = (await db.execute(GUARD_LOCK_PROBE)) as unknown as Array<{
            got: boolean;
          }>;
          lockFreeDuringRemoval = rows[0]?.got ?? null;

          throw sentinel; // roll back — alice stays super_admin
        });
      } catch (e) {
        if (e !== sentinel) throw e;
      }

      // Held during the uncommitted removal…
      expect(lockFreeDuringRemoval).toBe(false);

      // …and released after rollback.
      const after = (await db.execute(GUARD_LOCK_PROBE)) as unknown as Array<{
        got: boolean;
      }>;
      expect(after[0]?.got).toBe(true);

      // Rollback really restored alice.
      const row = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, alice.userId));
      expect(row[0]?.role).toBe('super_admin');
    },
    60_000,
  );

  it(
    'the REAL trigger refuses the removal that would reach zero (rolled back)',
    async () => {
      const sentinelSuffix = 'last-admin walk';
      let caught: unknown = null;
      const othersBefore = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.role, 'super_admin'),
            eq(users.status, 'active'),
            notInArray(users.id, [alice.userId, bob.userId]),
          ),
        );

      try {
        await db.transaction(async (tx) => {
          // Walk every OTHER active super_admin out of the population in
          // ONE statement (shared dev can hold hundreds of leftovers —
          // a per-row loop took 35 s). Per-row BEFORE triggers inside a
          // single UPDATE all see the statement-start snapshot, where
          // alice+bob are still active, so every row passes the guard.
          // All of this is rolled back below.
          if (othersBefore.length > 0) {
            await tx
              .update(users)
              .set({ status: 'disabled' })
              .where(
                and(
                  eq(users.role, 'super_admin'),
                  eq(users.status, 'active'),
                  notInArray(users.id, [alice.userId, bob.userId]),
                ),
              );
          }

          // Now alice+bob are the last two. Demoting alice passes
          // (bob remains) …
          await tx
            .update(users)
            .set({ role: 'admin' })
            .where(eq(users.id, alice.userId));

          // … demoting bob must be REFUSED by the trigger (remaining=0).
          await tx
            .update(users)
            .set({ role: 'admin' })
            .where(eq(users.id, bob.userId));

          throw new Error(`unreachable — trigger did not refuse (${sentinelSuffix})`);
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).not.toBeNull();
      expect(
        isLastAdminTriggerError(caught),
        `expected last-admin-protection ERRCODE 23514, got: ${String(caught)}`,
      ).toBe(true);

      // Rollback restored the walked rows and both seeds.
      const othersAfter = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.role, 'super_admin'),
            eq(users.status, 'active'),
            notInArray(users.id, [alice.userId, bob.userId]),
          ),
        );
      expect(othersAfter.length).toBe(othersBefore.length);
      const seeds = await db
        .select({ id: users.id, role: users.role, status: users.status })
        .from(users)
        .where(and(eq(users.role, 'super_admin'), eq(users.status, 'active')));
      const seedIds = seeds.map((s) => s.id);
      expect(seedIds).toContain(alice.userId);
      expect(seedIds).toContain(bob.userId);
    },
    60_000,
  );
});
