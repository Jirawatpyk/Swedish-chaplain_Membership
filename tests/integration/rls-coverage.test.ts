/**
 * RLS coverage meta-test (critique E12).
 *
 * Loops every tenant-scoped table in `public` and asserts:
 *   - RLS is ENABLED + FORCED
 *   - At least one policy is installed
 *
 * Any new tenant-scoped table added in a future migration without RLS
 * will fail CI here — preventing the "I forgot to enable RLS on the new
 * table" class of bug that would silently leak PII cross-tenant.
 *
 * F3 extension (T013): adds `members` and `contacts` to the coverage list.
 *
 * The list is explicit (not "every table with a tenant_id column") because
 * a few tables (`audit_log`) have NULLABLE tenant_id with a permissive policy
 * and a different shape of assertion. Keeping the list explicit forces a
 * deliberate code review every time a new multi-tenant table is added.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

// Tables that must have `rowsecurity = true`, `forcerowsecurity = true`,
// and at least one policy whose USING clause references
// `current_setting('app.current_tenant', ...)`.
const TENANT_SCOPED_TABLES = [
  // F2
  'membership_plans',
  'tenant_fee_config',
  // F3
  'members',
  'contacts',
];

describe('RLS coverage — every tenant-scoped table', () => {
  it.each(TENANT_SCOPED_TABLES)(
    '%s has RLS ENABLED + FORCED',
    async (table) => {
      const rows = await db.execute(sql`
        SELECT relrowsecurity::boolean AS rls, relforcerowsecurity::boolean AS force_rls
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ${table}
      `);
      expect(rows, `table ${table} missing`).toHaveLength(1);
      const r = rows[0] as { rls: boolean; force_rls: boolean };
      expect(r.rls, `${table}.rowsecurity`).toBe(true);
      expect(r.force_rls, `${table}.forcerowsecurity`).toBe(true);
    },
  );

  it.each(TENANT_SCOPED_TABLES)(
    '%s has at least one tenant-isolation policy',
    async (table) => {
      const rows = await db.execute(sql`
        SELECT policyname, qual FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `);
      expect(rows.length, `${table} has 0 policies`).toBeGreaterThan(0);
      // Every policy on a tenant-scoped table must constrain by tenant.
      for (const row of rows) {
        const r = row as { policyname: string; qual: string | null };
        expect(
          r.qual ?? '',
          `${table}.${r.policyname} does not reference app.current_tenant`,
        ).toMatch(/current_setting\('app\.current_tenant'/);
      }
    },
  );
});
