/**
 * #754 — `runInTenant` bounds every statement in its transaction. The Neon
 * pooler drops the connection's startup `statement_timeout`, so without a
 * local setting the bound reads 0 (unlimited) inside the tx. The value sits
 * above every budgeted lock wait (the 28 s dispatch lease, the 5 s
 * lock_timeouts) so their own 55P03 handling still fires first.
 *
 * e2e slowdown (21 Nov) — the four transaction-local settings go in ONE
 * statement: each separate statement is a round trip, and CI's runner talks
 * to a Neon branch in Singapore (~200 ms each).
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executed: { sql: string; params: unknown[] }[] = [];

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const dialect = new PgDialect();
      const tx = {
        execute: async (q: SQL) => {
          const { sql, params } = dialect.sqlToQuery(q);
          executed.push({ sql, params });
          return [];
        },
      };
      return fn(tx);
    },
  }),
}));

import { TENANT_TX_STATEMENT_TIMEOUT_MS, runInTenant, tenantTxSetupSql } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

describe('runInTenant transaction settings (#754, one round trip)', () => {
  it('sets row_security, the role, the 30 s statement_timeout and the tenant in one statement before the callback', async () => {
    executed.length = 0;
    let seenByCallback: typeof executed = [];
    await runInTenant(asTenantContext('swecham'), async () => {
      seenByCallback = [...executed];
    });

    expect(TENANT_TX_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(seenByCallback).toHaveLength(1);
    const [setup] = seenByCallback;
    // No bound parameters: postgres.js sends a parameterised statement as
    // Parse/Describe, then Bind/Execute (two round trips); a literal one is a
    // single simple query.
    expect(setup!.sql).toBe(
      "select set_config('row_security', 'on', true), set_config('role', 'chamber_app', true), " +
        "set_config('statement_timeout', '30000', true), set_config('app.current_tenant', 'swecham', true)",
    );
    expect(setup!.params).toEqual([]);
    expect(setup!.sql).toBe(tenantTxSetupSql('swecham'));
  });
});
