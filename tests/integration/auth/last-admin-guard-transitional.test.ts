/**
 * T018 — transitional last-administrator trigger rehearsal (016 PR 2, US2).
 *
 * Migration 0286 widened `users_last_admin_guard()` from `role = 'admin'` to
 * `role IN ('admin', 'super_admin')`. That function is the DB-layer backstop
 * behind the application pre-flights, and three of its properties are load
 * bearing in ways a unit test cannot reach:
 *
 *   1. ERRCODE `23514` + the substring `last-admin-protection` — the pair
 *      `isLastAdminTriggerError()` matches on. Change either and every caller
 *      silently reclassifies a correct refusal as a transient infra fault.
 *   2. BEFORE DELETE must `RETURN OLD`. Returning NEW/NULL cancels the delete
 *      with NO error and zero rows affected — the 0004 incident.
 *   3. The population must now include `super_admin`, otherwise Migration C's
 *      promotion can strand a tenant with zero protected rows.
 *
 * Every case runs inside a transaction that is ALWAYS rolled back, so the
 * shared dev branch keeps whatever administrators it already had.
 *
 * These tests deliberately drive raw SQL rather than the use cases: the point
 * is the DB layer's own behaviour with the application layer removed.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { isLastAdminTriggerError } from '@/lib/db-errors';

/** Marker so any row that somehow escapes the rollback is obvious. */
const TAG = 't018-transitional-guard';

interface Seeded {
  readonly ids: readonly string[];
}

/**
 * Run `body` inside a transaction seeded with exactly `roles.length` active
 * users carrying those roles, then ALWAYS roll back.
 *
 * The seeded users are the only administrators the guard can see because the
 * body first parks every pre-existing administrator as `disabled` inside the
 * same (doomed) transaction — otherwise the shared branch's real admins would
 * keep the count above 1 and the guard branch would never be entered.
 */
async function inRolledBackTx(
  roles: readonly string[],
  body: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], seeded: Seeded) => Promise<void>,
): Promise<void> {
  const ROLLBACK = new Error('intentional-rollback');
  try {
    await db.transaction(async (tx) => {
      // Park every real administrator so the guard sees only our fixtures.
      // Done as a single statement while ≥1 admin still exists at each step
      // would trip the guard, so disable them via a direct UPDATE that the
      // trigger permits: it only fires when the LAST one would go. Instead we
      // sidestep entirely by making our seeded rows exist FIRST.
      const ids: string[] = [];
      for (const [i, role] of roles.entries()) {
        const rows = await tx.execute(sql`
          INSERT INTO users (email, password_hash, role, status, display_name)
          VALUES (${`${TAG}-${i}-${role}@example.test`}, ${'x'}, ${role}::role, 'active', ${TAG})
          RETURNING id`);
        ids.push(String((rows as unknown as Array<{ id: string }>)[0]?.id));
      }
      // Now retire the pre-existing administrators; our fixtures keep the
      // count non-zero at every step so the trigger never blocks the setup.
      await tx.execute(sql`
        UPDATE users SET status = 'disabled'
        WHERE role IN ('admin', 'super_admin')
          AND status = 'active'
          AND display_name IS DISTINCT FROM ${TAG}`);

      await body(tx, { ids });
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

async function activeAdministratorCount(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE role IN ('admin', 'super_admin') AND status = 'active'`);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? -1);
}

describe('T018 transitional last-administrator trigger (migration 0286)', () => {
  it('setup sanity — the fixture is the only administrator left', async () => {
    await inRolledBackTx(['admin'], async (tx) => {
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('refuses to DEMOTE the last administrator', async () => {
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`UPDATE users SET role = 'manager'::role WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to DISABLE the last administrator', async () => {
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to DELETE the last administrator', async () => {
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`DELETE FROM users WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to ERASE (anonymise) the last administrator', async () => {
    // The erase path is an UPDATE that blanks identifying columns; if it also
    // retires the row it must trip the same guard.
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`
          UPDATE users
             SET status = 'disabled', email = ${`erased-${ids[0]}@invalid.test`}, display_name = NULL
           WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('counts super_admin as an administrator — a lone super_admin is protected', async () => {
    // The whole point of 0286: before it, this demotion succeeded because the
    // guard only looked at `role = 'admin'`.
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`UPDATE users SET role = 'manager'::role WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('permits promoting the last admin to super_admin (the Migration C move)', async () => {
    // Coverage is PRESERVED by this transition, so the guard must not fire —
    // this is the exact operation Migration C performs on every human admin.
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET role = 'super_admin'::role WHERE id = ${ids[0]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('permits demoting an admin while a super_admin remains (mixed population)', async () => {
    await inRolledBackTx(['super_admin', 'admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET role = 'manager'::role WHERE id = ${ids[1]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('permits a non-authorization UPDATE on the last administrator', async () => {
    // The guard must fire on role/status transitions only — an ordinary column
    // write on the last admin is not a coverage change.
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET display_name = ${TAG} WHERE id = ${ids[0]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('DELETE of a non-last administrator actually removes the row (0004 return-row)', async () => {
    // A BEFORE DELETE trigger that returns NEW/NULL cancels the delete with no
    // error and zero rows affected. Asserting the row is GONE is what catches
    // that class; asserting "no exception" would not.
    await inRolledBackTx(['admin', 'admin'], async (tx, { ids }) => {
      await tx.execute(sql`DELETE FROM users WHERE id = ${ids[1]}::uuid`);
      const rows = await tx.execute(sql`SELECT id FROM users WHERE id = ${ids[1]}::uuid`);
      expect((rows as unknown as unknown[]).length).toBe(0);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('raises SQLSTATE 23514 with the pinned substring', async () => {
    await inRolledBackTx(['admin'], async (tx, { ids }) => {
      let caught: unknown;
      try {
        await tx.execute(sql`DELETE FROM users WHERE id = ${ids[0]}::uuid`);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // Drizzle wraps the driver error ("Failed query: ...") and hangs the
      // original off `.cause`, so the SQLSTATE is one hop down — walk the
      // chain the same way `isLastAdminTriggerError` does rather than
      // asserting on the wrapper and getting `undefined`.
      let cur: unknown = caught;
      let pg: { code?: string; message?: string } | undefined;
      while (cur !== null && cur !== undefined) {
        const candidate = cur as { code?: string; message?: string; cause?: unknown };
        if (candidate.code === '23514') {
          pg = candidate;
          break;
        }
        cur = candidate.cause;
      }
      expect(pg, 'no 23514 error found in the cause chain').toBeDefined();
      expect(pg?.code).toBe('23514');
      expect(String(pg?.message)).toContain('last-admin-protection');
      expect(isLastAdminTriggerError(caught)).toBe(true);
    });
  });
});
