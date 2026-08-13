/**
 * T018 → T069 — STRICT last-administrator trigger rehearsal (016 PR 5).
 *
 * Migration 0288 narrowed `users_last_admin_guard()` from 0286's transitional
 * union (`role IN ('admin', 'super_admin')`) to `role = 'super_admin'` alone —
 * post-cutover a plain admin holds no administrative capability, so counting
 * one would let the last super_admin be demoted/disabled/erased while only
 * capability-less admins remain (SC-003). This file was authored for the
 * transitional population and updated to the strict one, per T069.
 *
 * That function is the DB-layer backstop behind the application pre-flights,
 * and three of its properties are load-bearing in ways a unit test cannot
 * reach:
 *
 *   1. ERRCODE `23514` + the substring `last-admin-protection` — the pair
 *      `isLastAdminTriggerError()` matches on. Change either and every caller
 *      silently reclassifies a correct refusal as a transient infra fault.
 *   2. BEFORE DELETE must `RETURN OLD`. Returning NEW/NULL cancels the delete
 *      with NO error and zero rows affected — the 0004 incident.
 *   3. The population must be `super_admin` ALONE, matching
 *      `administrativeRoles()` — plain admins are deliberately UNGUARDED now,
 *      and a trigger that still counted them would refuse operations the app
 *      layer permits.
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
 * same (doomed) transaction — our fixtures exist FIRST, so the count never
 * reaches zero while the real ones are retired.
 */
async function inRolledBackTx(
  roles: readonly string[],
  body: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], seeded: Seeded) => Promise<void>,
): Promise<void> {
  const ROLLBACK = new Error('intentional-rollback');
  try {
    await db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const [i, role] of roles.entries()) {
        const rows = await tx.execute(sql`
          INSERT INTO users (email, password_hash, role, status, display_name)
          VALUES (${`${TAG}-${i}-${role}@example.test`}, ${'x'}, ${role}::role, 'active', ${TAG})
          RETURNING id`);
        ids.push(String((rows as unknown as Array<{ id: string }>)[0]?.id));
      }
      // Retire the pre-existing administrators; the strict guard only counts
      // super_admin rows, so the population it sees afterwards is exactly our
      // seeded super_admin fixtures.
      await tx.execute(sql`
        UPDATE users SET status = 'disabled'
        WHERE role = 'super_admin'
          AND status = 'active'
          AND display_name IS DISTINCT FROM ${TAG}`);

      await body(tx, { ids });
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

/** The STRICT population — mirrors `administrativeRoles()` and migration 0288. */
async function activeAdministratorCount(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT COUNT(*)::int AS n FROM users
    WHERE role = 'super_admin' AND status = 'active'`);
  return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? -1);
}

describe('T069 strict last-administrator trigger (migration 0288)', () => {
  it('setup sanity — the fixture is the only administrator left', async () => {
    await inRolledBackTx(['super_admin'], async (tx) => {
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('refuses to DEMOTE the last super_admin', async () => {
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`UPDATE users SET role = 'admin'::role WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to DISABLE the last super_admin', async () => {
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`UPDATE users SET status = 'disabled' WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to DELETE the last super_admin', async () => {
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`DELETE FROM users WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('refuses to ERASE (anonymise) the last super_admin', async () => {
    // The erase path is an UPDATE that blanks identifying columns; if it also
    // retires the row it must trip the same guard.
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await expect(
        tx.execute(sql`
          UPDATE users
             SET status = 'disabled', email = ${`erased-${ids[0]}@invalid.test`}, display_name = NULL
           WHERE id = ${ids[0]}::uuid`),
      ).rejects.toSatisfy(isLastAdminTriggerError);
    });
  });

  it('a plain admin is UNGUARDED — demoting the last admin succeeds while a super_admin exists', async () => {
    // The inversion 0288 exists for: under 0286's union this demotion was
    // refused when the admin was the last of the PAIR. Post-cutover an admin
    // carries no administrative capability, so the strict trigger must let
    // routine admin lifecycle proceed as long as the super_admin population
    // is intact.
    await inRolledBackTx(['super_admin', 'admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET role = 'manager'::role WHERE id = ${ids[1]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('even the LAST plain admin is deletable — only super_admin coverage matters', async () => {
    // Sharper than the case above: zero admins left afterwards, and the guard
    // must still not fire, because admins are not the guarded population. The
    // application pre-flights agree (administrativeRoles() = ['super_admin']).
    await inRolledBackTx(['super_admin', 'admin'], async (tx, { ids }) => {
      await tx.execute(sql`DELETE FROM users WHERE id = ${ids[1]}::uuid`);
      const rows = await tx.execute(sql`SELECT id FROM users WHERE id = ${ids[1]}::uuid`);
      expect((rows as unknown as unknown[]).length).toBe(0);
    });
  });

  it('permits demoting a super_admin while another remains', async () => {
    await inRolledBackTx(['super_admin', 'super_admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET role = 'admin'::role WHERE id = ${ids[1]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('permits a non-authorization UPDATE on the last super_admin', async () => {
    // The guard must fire on role/status transitions only — an ordinary column
    // write on the last super_admin is not a coverage change.
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
      await tx.execute(sql`UPDATE users SET display_name = ${TAG} WHERE id = ${ids[0]}::uuid`);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('DELETE of a non-last super_admin actually removes the row (0004 return-row)', async () => {
    // A BEFORE DELETE trigger that returns NEW/NULL cancels the delete with no
    // error and zero rows affected. Asserting the row is GONE is what catches
    // that class; asserting "no exception" would not.
    await inRolledBackTx(['super_admin', 'super_admin'], async (tx, { ids }) => {
      await tx.execute(sql`DELETE FROM users WHERE id = ${ids[1]}::uuid`);
      const rows = await tx.execute(sql`SELECT id FROM users WHERE id = ${ids[1]}::uuid`);
      expect((rows as unknown as unknown[]).length).toBe(0);
      expect(await activeAdministratorCount(tx)).toBe(1);
    });
  });

  it('raises SQLSTATE 23514 with the pinned substring', async () => {
    await inRolledBackTx(['super_admin'], async (tx, { ids }) => {
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
