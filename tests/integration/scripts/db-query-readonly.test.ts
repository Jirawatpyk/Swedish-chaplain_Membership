/**
 * `pnpm db:query` against the live dev branch (D-034): a SELECT returns rows;
 * anything that writes, and any attempt to end the read-only transaction with
 * a second statement, is refused by Postgres itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { openReadOnlyClient, sessionOptions, type ReadOnlyClient } from '../../../scripts/lib/db-query-core';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? '';
const client: ReadOnlyClient = openReadOnlyClient(url, process.env.TEST_DB_HOST_BLOCKLIST);

afterAll(async () => {
  await client.end();
});

describe('db:query read-only client', () => {
  it('returns the rows of a SELECT', async () => {
    const rows = await client.query("SELECT 1 AS one, 'x' AS two");
    expect(rows).toEqual([{ one: 1, two: 'x' }]);
  });

  it('refuses DDL', async () => {
    // TEMP: Postgres refuses every CREATE in a read-only transaction, and a
    // temp table vanishes with the session if a regression ever lets it run.
    await expect(client.query('CREATE TEMP TABLE db_query_probe (id int)')).rejects.toThrow(/read-only transaction/);
  });

  it('refuses a data write', async () => {
    await expect(client.query('UPDATE members SET tenant_id = tenant_id WHERE false')).rejects.toThrow(/read-only transaction/);
  });

  it('refuses a sequence advance', async () => {
    // The probe needs a sequence to advance; without one it would resolve to [].
    expect(await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S'")).not.toEqual([{ n: 0 }]);
    await expect(
      client.query("SELECT nextval(c.oid) FROM pg_class c WHERE c.relkind = 'S' LIMIT 1"),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('refuses a second statement that would end the read-only transaction', async () => {
    await expect(client.query('SELECT 1; COMMIT')).rejects.toThrow(/multiple commands/);
    // A lone SET TRANSACTION READ WRITE is accepted (no query precedes it), so
    // the one-command rule is what keeps it from being followed by a write.
    await expect(
      client.query('SET TRANSACTION READ WRITE; UPDATE members SET tenant_id = tenant_id WHERE false'),
    ).rejects.toThrow(/multiple commands/);
  });

  it('refuses a statement that names a table holding secrets, before running it', async () => {
    await expect(client.query('SELECT id FROM sessions LIMIT 1')).rejects.toThrow(/sessions/);
  });

  it('opens every unpooled session read-only by default, with a 30 s statement timeout', async () => {
    // CI may hand a pooler URL, which refuses the options parameter: there the
    // client sends none, and the write tests above prove BEGIN READ ONLY holds.
    if (new URL(url).hostname.includes('-pooler')) {
      expect(sessionOptions(url)).toBe('');
      return;
    }
    expect(await client.query('SHOW default_transaction_read_only')).toEqual([{ default_transaction_read_only: 'on' }]);
    expect(await client.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '30s' }]);
  });

  it('still refuses a write, with a 30 s timeout, over the pooled URL', async () => {
    const pooled = openReadOnlyClient(process.env.DATABASE_URL ?? '', process.env.TEST_DB_HOST_BLOCKLIST);
    try {
      await expect(pooled.query('UPDATE members SET tenant_id = tenant_id WHERE false')).rejects.toThrow(
        /read-only transaction/,
      );
      // SET LOCAL inside the transaction: the timeout holds on the pooler too.
      expect(await pooled.query('SHOW statement_timeout')).toEqual([{ statement_timeout: '30s' }]);
    } finally {
      await pooled.end();
    }
  });
});
