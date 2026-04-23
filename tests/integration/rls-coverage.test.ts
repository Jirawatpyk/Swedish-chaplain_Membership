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
 * F5 extension (T028): adds `payments`, `refunds`, `tenant_payment_settings`,
 *   `processor_events` to the coverage list. `processor_events` is a
 *   special case — it has 4 per-command policies (SELECT/INSERT/UPDATE/DELETE)
 *   because its tenant_id is NULLABLE during the pre-resolution webhook
 *   window (see data-model.md § 5.4). Its DELETE policy uses `USING (false)`
 *   (explicit-deny, append-only), so the "policies must reference
 *   app.current_tenant" assertion allows an exception for USING-false policies.
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
  // F3
  'members',
  'contacts',
  // F4 (T018)
  'invoices',
  'invoice_lines',
  'credit_notes',
  'tenant_invoice_settings',
  'tenant_document_sequences',
  // F5 (T028)
  'payments',
  'refunds',
  'tenant_payment_settings',
  'processor_events',
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
        SELECT policyname, cmd, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ${table}
      `);
      expect(rows.length, `${table} has 0 policies`).toBeGreaterThan(0);
      // Every policy on a tenant-scoped table must EITHER constrain by
      // tenant via `app.current_tenant` (in USING or WITH CHECK), OR be
      // an explicit-deny (`USING (false)`) policy such as processor_events's
      // append-only DELETE guard. INSERT policies have NULL `qual` (USING
      // is not applicable); they express the tenant constraint via
      // `with_check`. Any other shape is a potential cross-tenant leak.
      for (const row of rows) {
        const r = row as {
          policyname: string;
          cmd: string;
          qual: string | null;
          with_check: string | null;
        };
        const qual = r.qual ?? '';
        const withCheck = r.with_check ?? '';
        const tenantRegex = /current_setting\('app\.current_tenant'/;
        const isTenantScoped = tenantRegex.test(qual) || tenantRegex.test(withCheck);
        const isExplicitDeny = /^\s*false\s*$/.test(qual);
        expect(
          isTenantScoped || isExplicitDeny,
          `${table}.${r.policyname} (cmd=${r.cmd}, qual=${qual}, with_check=${withCheck}) is ` +
            `neither tenant-scoped (current_setting in USING/WITH CHECK) nor explicit-deny (USING false)`,
        ).toBe(true);
      }
    },
  );

  // F5 — processor_events has 4 distinct per-command policies (data-
  // model.md § 5.4). Assert each SELECT/INSERT/UPDATE/DELETE command
  // has its own policy — not a single FOR ALL shortcut that would
  // accidentally allow DELETE via tenant match (append-only guard).
  it('processor_events has 4 distinct per-command RLS policies', async () => {
    const rows = await db.execute(sql`
      SELECT cmd, policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'processor_events'
      ORDER BY cmd
    `);
    const cmds = (rows as Array<{ cmd: string }>).map((r) => r.cmd).sort();
    expect(cmds, 'processor_events must have exactly SELECT/INSERT/UPDATE/DELETE policies').toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
  });
});
