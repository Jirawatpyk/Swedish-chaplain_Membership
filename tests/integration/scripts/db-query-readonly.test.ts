/**
 * `pnpm db:query` against the live dev branch (D-032): a SELECT returns rows;
 * anything that writes, and any attempt to end the read-only transaction with
 * a second statement, is refused by Postgres itself.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { openReadOnlyClient, type ReadOnlyClient } from '../../../scripts/lib/db-query-core';

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
    await expect(
      client.query("SELECT nextval(c.oid) FROM pg_class c WHERE c.relkind = 'S' LIMIT 1"),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('refuses a second statement that would end the read-only transaction', async () => {
    await expect(client.query('SELECT 1; COMMIT')).rejects.toThrow(/multiple commands/);
  });

  it('opens every session read-only by default, as a second layer', async () => {
    const rows = await client.query('SHOW default_transaction_read_only');
    expect(rows).toEqual([{ default_transaction_read_only: 'on' }]);
  });
});
