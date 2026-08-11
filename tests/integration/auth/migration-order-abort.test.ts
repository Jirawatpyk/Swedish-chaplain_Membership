/**
 * T043 — reversed-order (C-before-B) abort rehearsal (016 PR 3, US1).
 *
 * The A→B→C ordering is guaranteed by the journal, but the design also makes it
 * SELF-PROTECTING: if Migration C (promote human admins → super_admin) somehow
 * ran while the last-admin guard was still the OLD admin-ONLY population (i.e.
 * before Migration B's UNION rewrite landed), promoting the LAST admin would
 * leave zero `role='admin'` rows and the guard MUST abort with the pinned
 * `last-admin-protection` error — the deploy fails loudly instead of stranding
 * the tenant.
 *
 * This rehearsal proves that property both ways, against the REAL Migration C
 * SQL, inside transactions that always roll back (the CREATE OR REPLACE that
 * restores the old guard body is DDL and is rolled back with everything else, so
 * the shared dev branch keeps the current 0286 union guard):
 *
 *   - OLD admin-only guard active  → applying C on the last admin ABORTS
 *     (SQLSTATE 23514 + 'last-admin-protection', matched by isLastAdminTriggerError)
 *   - CURRENT 0286 union guard active → the identical promotion SUCCEEDS
 *     (super_admin counts as an administrator, so protection is continuous)
 *
 * The positive control is what makes the abort assertion meaningful: without it,
 * a guard that ALWAYS raised would pass the first case for the wrong reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { isLastAdminTriggerError } from '@/lib/db-errors';

const TAG = 't043-migration-order';

const MIGRATION_C_PATH = join(
  process.cwd(),
  'drizzle',
  'migrations',
  'pending',
  '0287_rbac_v2_promotion.sql',
);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The pre-Migration-B admin-ONLY guard body (verbatim from migration 0004). */
const OLD_ADMIN_ONLY_GUARD = `
CREATE OR REPLACE FUNCTION users_last_admin_guard()
  RETURNS trigger AS $$
DECLARE
  remaining_admins integer;
BEGIN
  IF (TG_OP = 'UPDATE'
      AND OLD.role = 'admin' AND OLD.status = 'active'
      AND (NEW.role <> 'admin' OR NEW.status <> 'active'))
  OR (TG_OP = 'DELETE'
      AND OLD.role = 'admin' AND OLD.status = 'active') THEN
    SELECT COUNT(*) INTO remaining_admins
      FROM users
      WHERE role = 'admin' AND status = 'active' AND id <> OLD.id;
    IF remaining_admins = 0 THEN
      RAISE EXCEPTION
        'last-admin-protection: refusing to leave zero active admins '
        '(security.md T-10, FR-011)'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`;

function migrationCStatements(): string[] {
  const raw = readFileSync(MIGRATION_C_PATH, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyMigrationC(tx: Tx): Promise<void> {
  for (const statement of migrationCStatements()) {
    await tx.execute(sql.raw(statement));
  }
}

/**
 * Seed a single lone active human admin and park every other active
 * administrator disabled, all inside `tx`. The lone admin keeps the union count
 * at 1 through setup so neither guard blocks it.
 */
async function seedLoneAdmin(tx: Tx): Promise<string> {
  const rows = await tx.execute(sql`
    INSERT INTO users (email, password_hash, role, status, display_name)
    VALUES (${`${TAG}-lone-admin@example.test`}, ${'x'}, 'admin'::role, 'active', ${TAG})
    RETURNING id`);
  const id = String((rows as unknown as Array<{ id: string }>)[0]?.id);
  await tx.execute(sql`
    UPDATE users SET status = 'disabled'
    WHERE role IN ('admin', 'super_admin')
      AND status = 'active'
      AND display_name IS DISTINCT FROM ${TAG}`);
  return id;
}

describe('T043 reversed-order (C-before-B) abort rehearsal (live Neon, real SQL)', () => {
  it('OLD admin-only guard: applying Migration C on the last admin ABORTS', async () => {
    // The tx rejects when the promotion trips the restored old guard; drizzle
    // rolls back on the throw, so the old-guard DDL never persists.
    await expect(
      db.transaction(async (tx) => {
        await seedLoneAdmin(tx);
        // Restore the pre-B admin-only population, then run the real promotion.
        await tx.execute(sql.raw(OLD_ADMIN_ONLY_GUARD));
        await applyMigrationC(tx);
      }),
    ).rejects.toSatisfy(isLastAdminTriggerError);
  });

  it('CURRENT 0286 union guard: the identical promotion SUCCEEDS (positive control)', async () => {
    const ROLLBACK = new Error('intentional-rollback');
    try {
      await db.transaction(async (tx) => {
        const id = await seedLoneAdmin(tx);
        // No guard restore — the ambient 0286 union guard is active. super_admin
        // counts as an administrator, so promoting the last admin is safe.
        await applyMigrationC(tx);
        const rows = await tx.execute(sql`SELECT role FROM users WHERE id = ${id}::uuid`);
        expect((rows as unknown as Array<{ role: string }>)[0]?.role).toBe('super_admin');
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
  });
});
