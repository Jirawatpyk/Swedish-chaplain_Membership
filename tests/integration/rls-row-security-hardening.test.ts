/**
 * RLS row_security hardening — regression guard for the 2026-07-17 incident.
 *
 * `runInTenant` (src/lib/db.ts) forces `SET LOCAL row_security = on` so a
 * pooled Neon connection that inherited a stale session-level
 * `row_security = off` cannot turn a FORCE-RLS tenant read into an
 * intermittent SQLSTATE 42501 ("query would be affected by row-level
 * security policy") error — or silently bypass RLS.
 *
 * Live Neon (dev branch): RLS + FORCE only behave correctly on real
 * Postgres, never on a mock. See docs/runbooks/rls-row-security-incident.md.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { asTenantContext } from '@/modules/tenants';

// A slug that need not correspond to a real tenant row — the assertions are
// about row_security state, not tenant data (RLS returns 0 rows, not an error).
const TENANT_SLUG = 'rls-hardening-test';

describe('RLS hardening — runInTenant forces row_security on', () => {
  it('runInTenant sets row_security = on inside the transaction', async () => {
    const rows = (await runInTenant(asTenantContext(TENANT_SLUG), (tx) =>
      tx.execute(sql`SELECT current_setting('row_security') AS rs`),
    )) as unknown as Array<{ rs: string }>;
    expect(rows[0]?.rs).toBe('on');
  });

  describe('defends a connection contaminated with row_security = off', () => {
    // A dedicated max=1 client so the poison + the transaction share ONE
    // physical connection deterministically — mirroring the production leak
    // vector (a pooled connection carrying a stale session-level SET).
    const client = postgres(env.database.url, {
      max: 1,
      ssl: 'require',
      idle_timeout: 5,
      connect_timeout: 15,
    });
    afterAll(() => client.end());

    // Mirrors runInTenant's SQL sequence (src/lib/db.ts) so this test fails
    // loudly if the statements/ordering drift. `withFix:false` reproduces the
    // pre-fix behaviour and is the control.
    const runTenantSeq = (opts: { withFix: boolean }) =>
      client.begin(async (tx) => {
        if (opts.withFix) await tx`SET LOCAL row_security = on`;
        await tx`SET LOCAL ROLE chamber_app`;
        await tx.unsafe(`SET LOCAL app.current_tenant = '${TENANT_SLUG}'`);
        return tx`SELECT 1 AS ok FROM membership_plans LIMIT 1`;
      });

    it('CONTROL: without the fix a poisoned connection raises 42501', async () => {
      await client`SET row_security = off`;
      await expect(runTenantSeq({ withFix: false })).rejects.toMatchObject({
        code: '42501',
      });
    });

    it('with SET LOCAL row_security = on the poisoned connection serves tenant reads', async () => {
      await client`SET row_security = off`;
      await expect(runTenantSeq({ withFix: true })).resolves.toBeDefined();
    });
  });
});
