import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyFreshMigrations,
  attachJournalTags,
  decideMigrationMode,
  type MigrationSqlClient,
  type TaggedMigration,
} from '../../../scripts/lib/migrate-fresh';

/**
 * A fake postgres-js client: one `__drizzle_migrations` table, an event log of
 * every statement with the scope it ran in (autocommit vs which transaction),
 * and rows that only become visible when their transaction commits.
 */
interface FakeOptions {
  readonly tableExists?: boolean;
  readonly rows?: ReadonlyArray<{ hash: string; created_at: number }>;
  readonly failOn?: string;
}

function fakeClient(options: FakeOptions = {}) {
  let tableExists = options.tableExists ?? false;
  const rows: Array<{ hash: string; created_at: number }> = [...(options.rows ?? [])];
  const events: Array<{ scope: string; sql: string }> = [];
  let txCount = 0;

  const run = async (scope: string, query: string, params: readonly unknown[] = [], pending?: typeof rows) => {
    events.push({ scope, sql: query });
    if (options.failOn !== undefined && query.includes(options.failOn)) {
      throw Object.assign(new Error(`boom: ${options.failOn}`), { code: '55P04' });
    }
    if (query.includes('to_regclass')) {
      return [{ t: tableExists ? 'drizzle.__drizzle_migrations' : null }];
    }
    if (/^\s*CREATE TABLE IF NOT EXISTS "drizzle"\."__drizzle_migrations"/.test(query)) {
      tableExists = true;
      return [];
    }
    if (query.includes('count(*)')) return [{ n: rows.length }];
    if (/^select hash from/i.test(query.trim())) return rows.map((r) => ({ hash: r.hash }));
    if (/^insert into "drizzle"\."__drizzle_migrations"/.test(query)) {
      (pending ?? rows).push({ hash: String(params[0]), created_at: Number(params[1]) });
      return [];
    }
    return [];
  };

  const client: MigrationSqlClient = {
    unsafe: (query, params) => run('autocommit', query, params),
    begin: async (fn) => {
      txCount += 1;
      const scope = `tx${txCount}`;
      const pending: typeof rows = [];
      events.push({ scope, sql: 'BEGIN' });
      try {
        const result = await fn({ unsafe: (query, params) => run(scope, query, params, pending) });
        rows.push(...pending);
        events.push({ scope, sql: 'COMMIT' });
        return result;
      } catch (error) {
        events.push({ scope, sql: 'ROLLBACK' });
        throw error;
      }
    },
  };
  return { client, rows, events, txCount: () => txCount };
}

function migration(tag: string, folderMillis: number, sql: string[] = [`select '${tag}';`]): TaggedMigration {
  return { tag, folderMillis, hash: `hash-${tag}`, sql };
}

describe('decideMigrationMode', () => {
  it('is fresh when drizzle.__drizzle_migrations does not exist (and never counts a missing table)', async () => {
    const fake = fakeClient({ tableExists: false });
    expect(await decideMigrationMode(fake.client)).toBe('fresh');
    expect(fake.events.some((e) => e.sql.includes('count(*)'))).toBe(false);
  });

  it('is fresh when the table exists with zero rows', async () => {
    const fake = fakeClient({ tableExists: true });
    expect(await decideMigrationMode(fake.client)).toBe('fresh');
  });

  it('is normal when the table holds at least one row', async () => {
    const fake = fakeClient({ tableExists: true, rows: [{ hash: 'h', created_at: 1 }] });
    expect(await decideMigrationMode(fake.client)).toBe('normal');
  });
});

describe('applyFreshMigrations', () => {
  it('creates the drizzle schema and table with drizzle’s own DDL before anything else', async () => {
    const fake = fakeClient();
    await applyFreshMigrations(fake.client, [migration('0000_a', 1)]);
    expect(fake.events[0]).toEqual({ scope: 'autocommit', sql: 'CREATE SCHEMA IF NOT EXISTS "drizzle"' });
    expect(fake.events[1]?.sql.replace(/\s+/g, ' ').trim()).toBe(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" ( id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint )',
    );
  });

  it('applies every file in journal order, one transaction per file, writing (hash, folderMillis)', async () => {
    const fake = fakeClient();
    const list = [migration('0000_a', 10), migration('0001_b', 20), migration('0002_c', 30)];
    const result = await applyFreshMigrations(fake.client, list);

    expect(result).toMatchObject({ applied: 3, skipped: 0 });
    expect(fake.txCount()).toBe(3);
    const bodies = fake.events.filter((e) => e.sql.startsWith('select \'')).map((e) => [e.scope, e.sql]);
    expect(bodies).toEqual([
      ['tx1', "select '0000_a';"],
      ['tx2', "select '0001_b';"],
      ['tx3', "select '0002_c';"],
    ]);
    expect(fake.rows).toEqual([
      { hash: 'hash-0000_a', created_at: 10 },
      { hash: 'hash-0001_b', created_at: 20 },
      { hash: 'hash-0002_c', created_at: 30 },
    ]);
  });

  it('decides by HASH: applies an entry whose `when` is lower than the previous one, skips a recorded hash', async () => {
    // Mirrors the journal's 0023→0024 and 0029→0030 inversions. A created_at
    // comparison would silently drop 0001_low; the hash check must not.
    const fake = fakeClient({ tableExists: true, rows: [{ hash: 'hash-0002_done', created_at: 15 }] });
    const list = [migration('0000_high', 100), migration('0001_low', 50), migration('0002_done', 15)];
    const result = await applyFreshMigrations(fake.client, list);

    expect(result).toMatchObject({ applied: 2, skipped: 1 });
    expect(fake.events.some((e) => e.sql === "select '0001_low';")).toBe(true);
    expect(fake.events.some((e) => e.sql === "select '0002_done';")).toBe(false);
  });

  it('commits a file’s own ADD VALUE statements in autocommit before that file’s transaction', async () => {
    // 0308 adds broadcast_status values and builds a partial index on one of
    // them in the same file; inside one transaction that is 55P04.
    const add = `ALTER TYPE "broadcast_status" ADD VALUE IF NOT EXISTS 'in_design';`;
    const fake = fakeClient();
    await applyFreshMigrations(fake.client, [
      migration('0000_enum', 1, [`${add}--> statement-breakpoint`, `CREATE INDEX i ON b (s) WHERE s = 'in_design';`]),
    ]);
    const addEvents = fake.events.filter((e) => e.sql === add);
    expect(addEvents.map((e) => e.scope)).toEqual(['autocommit']);
    const begin = fake.events.findIndex((e) => e.sql === 'BEGIN');
    expect(fake.events.findIndex((e) => e.sql === add)).toBeLessThan(begin);
  });

  it('stops at the failing file, leaves earlier files committed, and names the file', async () => {
    const fake = fakeClient({ failOn: "select '0002_bad';" });
    const list = [migration('0000_a', 1), migration('0001_b', 2), migration('0002_bad', 3), migration('0003_d', 4)];

    await expect(applyFreshMigrations(fake.client, list)).rejects.toThrow(
      /0002_bad \(file 3 of 4; 2 committed before it\).*boom/,
    );
    expect(fake.rows.map((r) => r.hash)).toEqual(['hash-0000_a', 'hash-0001_b']);
    expect(fake.events.some((e) => e.sql === "select '0003_d';")).toBe(false);
    expect(fake.events.filter((e) => e.sql === 'ROLLBACK')).toHaveLength(1);
  });

  it('leaves the database "up to date" for a later drizzle migrate()', async () => {
    // drizzle's PgDialect.migrate picks `order by created_at desc limit 1` and
    // applies an entry only when `created_at < folderMillis`. Replay exactly
    // that predicate over the rows fresh mode wrote.
    const fake = fakeClient();
    const list = [migration('0000_a', 10), migration('0001_b', 40), migration('0002_low', 20), migration('0003_d', 50)];
    await applyFreshMigrations(fake.client, list);

    const last = [...fake.rows].sort((a, b) => b.created_at - a.created_at)[0];
    expect(last?.created_at).toBe(50);
    expect(list.filter((m) => last === undefined || last.created_at < m.folderMillis)).toEqual([]);
  });
});

describe('attachJournalTags', () => {
  it('zips each migration with its journal tag, in order', () => {
    const tagged = attachJournalTags(
      [
        { sql: ['a'], folderMillis: 1, hash: 'h1' },
        { sql: ['b'], folderMillis: 2, hash: 'h2' },
      ],
      [{ tag: '0000_a' }, { tag: '0001_b' }],
    );
    expect(tagged.map((m) => m.tag)).toEqual(['0000_a', '0001_b']);
  });

  it('refuses a migrations/journal length mismatch', () => {
    expect(() => attachJournalTags([{ sql: ['a'], folderMillis: 1, hash: 'h1' }], [])).toThrow(/1 migrations.*0 journal entries/);
  });
});

describe('the real journal', () => {
  it('ends on its maximum `when`, so a later normal migrate() after fresh mode applies nothing', () => {
    const journal = JSON.parse(
      readFileSync(resolve(__dirname, '../../../drizzle/migrations/meta/_journal.json'), 'utf-8'),
    ) as { entries: Array<{ tag: string; when: number }> };
    expect(journal.entries.length).toBeGreaterThan(300);
    const max = Math.max(...journal.entries.map((e) => e.when));
    expect(journal.entries.at(-1)?.when).toBe(max);
  });
});
