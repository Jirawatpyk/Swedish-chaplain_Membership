/**
 * T019 — erase-user last-super-admin pre-flight (016 PR 2, US2 / SC-003).
 *
 * The lockout this guards against: once D4 makes `users.manage` SA-only
 * (flag ON), erasing the last active super_admin while only plain admins
 * remain leaves NOBODY able to invite/promote staff — a PERMANENT tenant
 * lockout. The DB trigger (migration 0286) does NOT catch it: its population
 * is the admin ∪ super_admin UNION until PR 5, so a surviving plain admin
 * keeps the union non-empty and the trigger happily permits the erase.
 *
 * The app-layer pre-flight in `erase-user.ts` is therefore the ONLY line of
 * defence for this case, and its administrative population must be
 * FLAG-AWARE (`administrativeRoles(rbacV2)` — T026 design correction):
 *
 *   - flag OFF → admin ∪ super_admin (mirrors trigger 0286; pre-cutover
 *     erasures of the pre-minted SA stay possible while admins still hold
 *     full capability)
 *   - flag ON  → super_admin ALONE (app stricter than the DB trigger — safe)
 *
 * Every case runs inside a doomed transaction (ALWAYS rolled back) with the
 * use case's repo reads bound to that tx, so the shared dev branch is never
 * mutated. The refusal path never reaches the write tx, so binding only the
 * READS keeps the pre-flight fully real: real seeded rows, real SQL counts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { eraseUser, type EraseUserDeps } from '@/modules/auth/application/erase-user';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { EmailAddress, UserId } from '@/modules/auth/domain/branded';
import type { Role } from '@/modules/auth/domain/role';
import type { UserAccount, UserStatus } from '@/modules/auth/domain/user';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

/** Marker so any row that somehow escapes the rollback is obvious. */
const TAG = 't019-erase-last-sa';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface Seeded {
  readonly ids: readonly string[];
}

/**
 * Run `body` inside a transaction seeded with exactly `roles.length` active
 * users carrying those roles, then ALWAYS roll back. Pre-existing
 * administrators are parked as `disabled` inside the same (doomed) tx so the
 * seeded rows are the only administrators any count can see (same idiom as
 * last-admin-guard-transitional.test.ts).
 */
async function inRolledBackTx(
  roles: readonly string[],
  body: (tx: Tx, seeded: Seeded) => Promise<void>,
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
      // Retire the pre-existing administrators; our fixtures keep the union
      // count non-zero at every step so the 0286 trigger never blocks setup.
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

/**
 * `EraseUserDeps` with the pre-flight READS bound to the doomed tx and the
 * WRITE arms replaced by recorders. The count mirrors the production WHERE
 * clause over the live seeded rows; the optional `roles` narrowing is the
 * exact seam under test — a use case that never narrows (no argument) gets
 * today's hardcoded union, byte-identical to the repo query it replaces.
 */
function depsOverTx(tx: Tx): { deps: EraseUserDeps; anonymised: string[] } {
  const anonymised: string[] = [];
  const deps: EraseUserDeps = {
    users: {
      findById: async (id) => {
        const rows = await tx.execute(sql`
          SELECT id, email, role, status FROM users WHERE id = ${id}::uuid`);
        const row = (
          rows as unknown as Array<{ id: string; email: string; role: string; status: string }>
        )[0];
        if (!row) return null;
        const account: UserAccount = {
          id: row.id as UserId,
          email: row.email as EmailAddress,
          role: row.role as Role,
          status: row.status as UserStatus,
          createdAt: new Date(0),
          lastSignInAt: null,
          lastPasswordChangedAt: null,
          failedSignInCount: 0,
          lockedUntil: null,
          displayName: null,
          emailVerified: true,
          requiresPasswordReset: false,
        };
        return account;
      },
      countActiveAdministrators: async (roles?: readonly Role[]) => {
        const population: readonly string[] = roles ?? ['admin', 'super_admin'];
        const inList = sql.join(
          population.map((r) => sql`${r}::role`),
          sql`, `,
        );
        const rows = await tx.execute(sql`
          SELECT COUNT(*)::int AS n FROM users
          WHERE role IN (${inList}) AND status = 'active'`);
        return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? -1);
      },
      anonymiseErasedInTx: async (_tx, id) => {
        anonymised.push(String(id));
        return { erased: true };
      },
    },
    sessions: { deleteByUserIdInTx: async () => 0 },
    audit: { appendInTx: async () => {} },
  };
  return { deps, anonymised };
}

function eraseInput(userId: string) {
  return {
    userId,
    actorUserId: 'admin-it-t019',
    requestId: `it-t019-${Date.now()}`,
    sourceIp: null,
  };
}

describe('T019 erase-user last-super-admin pre-flight (live Neon, SC-003)', () => {
  it('flag ON: refuses to erase the LAST super_admin even though a plain admin remains', async () => {
    // {super_admin, admin} — the exact SC-003 lockout population: the DB
    // trigger's union stays at 2 so ONLY the app pre-flight can refuse.
    await inRolledBackTx(['super_admin', 'admin'], async (tx, { ids }) => {
      const { deps, anonymised } = depsOverTx(tx);
      const res = await eraseUser(eraseInput(ids[0]!), deps);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('erase-user-last-admin');
      // The PRE-FLIGHT refused (clean typed err), not the trigger path.
      expect(res.error.cause).toBe('last-administrator-preflight');
      // No write arm was ever reached.
      expect(anonymised).toHaveLength(0);
    });
  });

  it('flag ON: erasing a NON-last super_admin passes the pre-flight', async () => {
    await inRolledBackTx(['super_admin', 'super_admin'], async (tx, { ids }) => {
      const { deps, anonymised } = depsOverTx(tx);
      const res = await eraseUser(eraseInput(ids[0]!), deps);
      expect(res.ok).toBe(true);
      expect(anonymised).toEqual([ids[0]]);
    });
  });

  it('flag ON: erasing a plain admin is NOT pre-flight-refused (not administrative on the ON leg)', async () => {
    // On the ON leg a plain admin no longer holds `users.manage`, so erasing
    // one cannot cause the SC-003 lockout; the 0286 trigger remains the
    // backstop for the union invariant (covered by T018).
    await inRolledBackTx(['super_admin', 'admin'], async (tx, { ids }) => {
      const { deps, anonymised } = depsOverTx(tx);
      const res = await eraseUser(eraseInput(ids[1]!), deps);
      expect(res.ok).toBe(true);
      expect(anonymised).toEqual([ids[1]]);
    });
  });

  // The two flag-OFF cases (union-population erase + last-plain-admin
  // refusal) died with the legacy leg in PR 5: administrativeRoles() is
  // super_admin-only now, matching the strict trigger (migration 0288), and
  // the pre-cutover recovery window they protected has closed.
});

/**
 * The REAL repo query narrows by the supplied population — the doomed-tx
 * block above binds reads to a test shim, so this block is the only proof
 * the production `inArray` WHERE clause actually discriminates. Uses a
 * committed plain-admin row (routine on this branch — account-lifecycle
 * seeds the same) and relative assertions, never absolute counts, so
 * whatever administrators already live on the shared dev branch cannot
 * break it.
 */
describe('userRepo.countActiveAdministrators population narrowing (live Neon)', () => {
  const created: TestUser[] = [];

  afterEach(async () => {
    for (const u of created.splice(0)) await deleteTestUser(u);
  });

  it('a new plain admin moves the union count but NOT the super_admin-only count', async () => {
    const saOnlyBefore = await userRepo.countActiveAdministrators(['super_admin']);
    const unionBefore = await userRepo.countActiveAdministrators(['admin', 'super_admin']);

    created.push(await createActiveTestUser('admin'));

    // A hardcoded-union mutant counts the new admin in BOTH calls.
    expect(await userRepo.countActiveAdministrators(['super_admin'])).toBe(saOnlyBefore);
    expect(await userRepo.countActiveAdministrators(['admin', 'super_admin'])).toBe(
      unionBefore + 1,
    );
  });
});
