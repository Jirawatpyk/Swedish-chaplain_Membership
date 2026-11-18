/**
 * #754 — `runInTenant` bounds every statement in its transaction. The Neon
 * pooler drops the connection's startup `statement_timeout`, so without a
 * `SET LOCAL` the bound reads 0 (unlimited) inside the tx. The value sits
 * above every budgeted lock wait (the 28 s dispatch lease, the 5 s
 * lock_timeouts) so their own 55P03 handling still fires first.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executed: string[] = [];

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const dialect = new PgDialect();
      const tx = {
        execute: async (q: SQL) => {
          executed.push(dialect.sqlToQuery(q).sql);
          return [];
        },
      };
      return fn(tx);
    },
  }),
}));

import { TENANT_TX_STATEMENT_TIMEOUT_MS, runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

describe('runInTenant statement_timeout (#754)', () => {
  it('sets a 30 s SET LOCAL statement_timeout after the role switch and before the callback', async () => {
    executed.length = 0;
    let seenByCallback: string[] = [];
    await runInTenant(asTenantContext('swecham'), async () => {
      seenByCallback = [...executed];
    });

    expect(TENANT_TX_STATEMENT_TIMEOUT_MS).toBe(30_000);
    const timeoutAt = seenByCallback.indexOf('SET LOCAL statement_timeout = 30000');
    const roleAt = seenByCallback.indexOf('SET LOCAL ROLE chamber_app');
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(roleAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeGreaterThan(roleAt);
  });
});
