import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyFreshMigrations,
  attachJournalTags,
  decideMigrationMode,
  disallowedUnrecorded,
  findUnrecordedMigrations,
  isPooledConnection,
  LEGACY_UNRECORDED_TAGS,
  migrationTargetHost,
  withMigrationLock,
  type MigrationSqlClient,
  type TaggedMigration,
} from '../../../scripts/lib/migrate-fresh';

/**
 * A fake postgres-js client: the migrations table, the fresh-mode marker and
 * `public.users` (created by 0000) as separate relations; an event log of every
 * statement with the scope it ran in (autocommit vs which transaction); rows
 * that only become visible when their transaction commits; and one advisory
 * lock slot.
 */
interface FakeOptions {
  readonly tableExists?: boolean;
  readonly markerExists?: boolean;
  readonly appTablesExist?: boolean;
  readonly rows?: ReadonlyArray<{ hash: string; created_at: number }>;
  readonly failOn?: string;
  readonly lockHeld?: boolean;
  /** Another session holds the lock for this many failed polls, then releases it. */
  readonly otherHoldsForPolls?: number;
  readonly unlock?: 'ok' | 'throws' | 'false';
}

function fakeClient(options: FakeOptions = {}) {
  let tableExists = options.tableExists ?? false;
  let markerExists = options.markerExists ?? false;
  const appTablesExist = options.appTablesExist ?? false;
  let failOn = options.failOn;
  let lockHeld = options.lockHeld ?? false;
  let otherHolds = options.otherHoldsForPolls ?? 0;
  const rows: Array<{ hash: string; created_at: number }> = [...(options.rows ?? [])];
  const events: Array<{ scope: string; sql: string }> = [];
  let txCount = 0;

  const run = async (scope: string, query: string, params: readonly unknown[] = [], pending?: typeof rows) => {
    events.push({ scope, sql: query });
    if (failOn !== undefined && query.includes(failOn)) {
      throw Object.assign(new Error(`boom: ${failOn}`), { code: '55P04' });
    }
    const reg = /to_regclass\('([^']+)'\)/.exec(query);
    if (reg !== null) {
      const name = reg[1];
      const exists =
        name === 'drizzle.__drizzle_migrations'
          ? tableExists
          : name === 'drizzle.__fresh_migrate_in_progress'
            ? markerExists
            : name === 'public.users'
              ? appTablesExist
              : false;
      return [{ t: exists ? name : null }];
    }
    if (/pg_try_advisory_lock/.test(query)) {
      if (otherHolds > 0) {
        otherHolds -= 1;
        return [{ locked: false }];
      }
      const got = !lockHeld;
      lockHeld = true;
      return [{ locked: got }];
    }
    if (/pg_advisory_unlock/.test(query)) {
      if (options.unlock === 'throws') throw new Error('connection reset during unlock');
      lockHeld = false;
      return [{ unlocked: options.unlock !== 'false' }];
    }
    if (/^\s*CREATE TABLE IF NOT EXISTS "drizzle"\."__drizzle_migrations"/.test(query)) {
      tableExists = true;
      return [];
    }
    if (/^\s*CREATE TABLE IF NOT EXISTS "drizzle"\."__fresh_migrate_in_progress"/.test(query)) {
      markerExists = true;
      return [];
    }
    if (/^\s*DROP TABLE IF EXISTS "drizzle"\."__fresh_migrate_in_progress"/.test(query)) {
      markerExists = false;
      return [];
    }
    if (query.includes('count(*)')) return [{ n: rows.length }];
    if (/^select hash, created_at from/i.test(query.trim())) {
      return rows.map((r) => ({ hash: r.hash, created_at: String(r.created_at) }));
    }
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
  return {
    client,
    rows,
    events,
    txCount: () => txCount,
    markerExists: () => markerExists,
    lockHeld: () => lockHeld,
    clearFailure: () => {
      failOn = undefined;
    },
  };
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

  it('is fresh (a resume) when the in-progress marker exists, even with rows recorded', async () => {
    const fake = fakeClient({ tableExists: true, markerExists: true, rows: [{ hash: 'h', created_at: 1 }] });
    expect(await decideMigrationMode(fake.client)).toBe('fresh');
  });

  it('refuses an empty or missing migrations table when app tables already exist', async () => {
    await expect(decideMigrationMode(fakeClient({ tableExists: true, appTablesExist: true }).client)).rejects.toThrow(
      /public\.users exists/,
    );
    await expect(decideMigrationMode(fakeClient({ tableExists: false, appTablesExist: true }).client)).rejects.toThrow(
      /public\.users exists/,
    );
  });
});

describe('withMigrationLock', () => {
  it('holds the advisory lock for the duration and releases it, even on failure', async () => {
    const fake = fakeClient();
    await withMigrationLock(fake.client, async () => {
      expect(fake.lockHeld()).toBe(true);
    });
    expect(fake.lockHeld()).toBe(false);
    await expect(
      withMigrationLock(fake.client, async () => {
        throw new Error('inner');
      }),
    ).rejects.toThrow('inner');
    expect(fake.lockHeld()).toBe(false);
  });

  // A fake clock: sleep() advances now() instead of waiting.
  function clock() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
  }

  it('waits for a lock another deploy holds, polling every 2 s, then runs', async () => {
    const fake = fakeClient({ otherHoldsForPolls: 3 });
    const c = clock();
    let ran = false;
    await withMigrationLock(
      fake.client,
      async () => {
        ran = true;
      },
      { sleep: c.sleep, now: c.now, warn: () => {} },
    );
    expect(ran).toBe(true);
    expect(c.sleeps).toEqual([2_000, 2_000, 2_000]);
    expect(fake.events.some((e) => /pg_advisory_lock\(/.test(e.sql))).toBe(false);
  });

  it('gives up after about 5 minutes with the original message, never running fn', async () => {
    const fake = fakeClient({ otherHoldsForPolls: 10_000 });
    const c = clock();
    let ran = false;
    await expect(
      withMigrationLock(
        fake.client,
        async () => {
          ran = true;
        },
        { sleep: c.sleep, now: c.now, warn: () => {} },
      ),
    ).rejects.toThrow(/another run-migrations holds the lock/);
    expect(ran).toBe(false);
    expect(c.now()).toBeGreaterThanOrEqual(300_000);
    expect(c.now()).toBeLessThan(310_000);
  });

  it('skips the lock on a pooled (PgBouncer) connection, warns, and runs as before', async () => {
    const fake = fakeClient();
    const warnings: string[] = [];
    let ran = false;
    await withMigrationLock(
      fake.client,
      async () => {
        ran = true;
      },
      { pooled: true, warn: (w) => warnings.push(w) },
    );
    expect(ran).toBe(true);
    expect(fake.events.some((e) => /advisory/.test(e.sql))).toBe(false);
    expect(warnings.join('\n')).toMatch(/pooled.*without the advisory lock/i);
  });

  it.each(['throws', 'false'] as const)('an unlock that %s only warns and never masks the result', async (unlock) => {
    const warnings: string[] = [];
    const ok = fakeClient({ unlock });
    await expect(withMigrationLock(ok.client, async () => 'done', { warn: (w) => warnings.push(w) })).resolves.toBe(
      'done',
    );
    expect(warnings.join('\n')).toMatch(/unlock/i);
    const failing = fakeClient({ unlock });
    await expect(
      withMigrationLock(
        failing.client,
        async () => {
          throw new Error('the real migration error');
        },
        { warn: () => {} },
      ),
    ).rejects.toThrow('the real migration error');
  });
});

describe('isPooledConnection', () => {
  it('is true only for a Neon -pooler host', () => {
    expect(isPooledConnection('postgresql://u:p@ep-x-123-pooler.c-3.ap-southeast-1.aws.neon.tech/db')).toBe(true);
    expect(isPooledConnection('postgresql://u:p@ep-x-123.c-3.ap-southeast-1.aws.neon.tech/db')).toBe(false);
    expect(isPooledConnection('not a url')).toBe(false);
  });
});

describe('migrationTargetHost', () => {
  it('gives the hostname only, never credentials, and a fixed message for a malformed URL', () => {
    expect(migrationTargetHost('postgresql://user:s3cret@ep-x-123.aws.neon.tech/db?sslmode=require')).toEqual({
      ok: true,
      host: 'ep-x-123.aws.neon.tech',
    });
    const bad = migrationTargetHost('postgresql://user:s3cret@[bad');
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('s3cret');
  });
});

describe('scripts/run-migrations.ts env loading', () => {
  it('loads no env file of its own: the caller passes --env-file (db:migrate) or the platform injects env', () => {
    const source = readFileSync(resolve(__dirname, '../../../scripts/run-migrations.ts'), 'utf-8');
    const code = source
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(code).not.toMatch(/loadEnvFile/);
    expect(code).toMatch(/migrationTargetHost\(/);
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:migrate']).toMatch(/--env-file=\.env\.local .*scripts\/run-migrations\.ts/);
  });
});

describe('applyFreshMigrations', () => {
  it('creates the drizzle schema and table with drizzle’s own DDL, then the marker, before any file', async () => {
    const fake = fakeClient();
    await applyFreshMigrations(fake.client, [migration('0000_a', 1)]);
    expect(fake.events[0]).toEqual({ scope: 'autocommit', sql: 'CREATE SCHEMA IF NOT EXISTS "drizzle"' });
    expect(fake.events[1]?.sql.replace(/\s+/g, ' ').trim()).toBe(
      'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" ( id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint )',
    );
    const marker = fake.events.findIndex((e) => /__fresh_migrate_in_progress/.test(e.sql) && /CREATE/.test(e.sql));
    expect(marker).toBeGreaterThan(1);
    expect(marker).toBeLessThan(fake.events.findIndex((e) => e.sql === 'BEGIN'));
  });

  it('drops the marker only after every file has committed', async () => {
    const fake = fakeClient();
    await applyFreshMigrations(fake.client, [migration('0000_a', 1), migration('0001_b', 2)]);
    expect(fake.markerExists()).toBe(false);
    const drop = fake.events.findIndex((e) => /DROP TABLE IF EXISTS "drizzle"\."__fresh_migrate_in_progress"/.test(e.sql));
    const lastCommit = fake.events.map((e) => e.sql).lastIndexOf('COMMIT');
    expect(drop).toBeGreaterThan(lastCommit);
  });

  it('applies every file in journal order, one transaction per file, writing (hash, folderMillis)', async () => {
    const fake = fakeClient();
    const list = [migration('0000_a', 10), migration('0001_b', 20), migration('0002_c', 30)];
    const result = await applyFreshMigrations(fake.client, list);

    expect(result).toMatchObject({ applied: 3, skipped: 0 });
    expect(fake.txCount()).toBe(3);
    const bodies = fake.events.filter((e) => e.sql.startsWith("select '")).map((e) => [e.scope, e.sql]);
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
    const fake = fakeClient({ tableExists: true, rows: [{ hash: 'hash-0002_done', created_at: 15 }] });
    const list = [migration('0000_high', 100), migration('0001_low', 50), migration('0002_done', 15)];
    const result = await applyFreshMigrations(fake.client, list);

    expect(result).toMatchObject({ applied: 2, skipped: 1 });
    expect(fake.events.some((e) => e.sql === "select '0001_low';")).toBe(true);
    expect(fake.events.some((e) => e.sql === "select '0002_done';")).toBe(false);
  });

  it('also skips an entry whose folderMillis is recorded under another hash (a CRLF vs LF checkout)', async () => {
    const fake = fakeClient({ tableExists: true, rows: [{ hash: 'hash-from-the-other-os', created_at: 20 }] });
    const result = await applyFreshMigrations(fake.client, [migration('0000_a', 10), migration('0001_b', 20)]);
    expect(result).toMatchObject({ applied: 1, skipped: 1 });
    expect(fake.events.some((e) => e.sql === "select '0001_b';")).toBe(false);
  });

  it('commits a file’s own ADD VALUE statements in autocommit before that file’s transaction', async () => {
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

  it('stops at the failing file, leaves earlier files committed and the marker in place, and names the file', async () => {
    const fake = fakeClient({ failOn: "select '0002_bad';" });
    const list = [migration('0000_a', 1), migration('0001_b', 2), migration('0002_bad', 3), migration('0003_d', 4)];

    await expect(applyFreshMigrations(fake.client, list)).rejects.toThrow(
      /0002_bad \(file 3 of 4; 2 committed before it\).*boom/,
    );
    expect(fake.rows.map((r) => r.hash)).toEqual(['hash-0000_a', 'hash-0001_b']);
    expect(fake.events.some((e) => e.sql === "select '0003_d';")).toBe(false);
    expect(fake.events.filter((e) => e.sql === 'ROLLBACK')).toHaveLength(1);
    expect(fake.markerExists()).toBe(true);
  });

  it('resumes in fresh mode after a failure at 0023 and applies 0024, whose `when` is lower', async () => {
    // The real 0023→0024 inversion: drizzle's normal path would compare
    // created_at against 0023's and skip 0024 for ever.
    const list = [
      migration('0022_x', 1776500000000),
      migration('0023_notification_type_f4', 1776720004000),
      migration('0024_invoicing_receipt_pdf_split', 1776581490367),
    ];
    const fake = fakeClient({ failOn: "select '0023_notification_type_f4';" });
    await expect(applyFreshMigrations(fake.client, list)).rejects.toThrow(/0023_notification_type_f4/);
    expect(await decideMigrationMode(fake.client)).toBe('fresh');

    fake.clearFailure();
    const result = await applyFreshMigrations(fake.client, list);
    expect(result).toMatchObject({ applied: 2, skipped: 1 });
    expect(fake.rows.map((r) => r.hash)).toEqual([
      'hash-0022_x',
      'hash-0023_notification_type_f4',
      'hash-0024_invoicing_receipt_pdf_split',
    ]);
    expect(fake.markerExists()).toBe(false);
    expect(await decideMigrationMode(fake.client)).toBe('normal');
  });

  it('leaves the database "up to date" for a later drizzle migrate()', async () => {
    const fake = fakeClient();
    const list = [migration('0000_a', 10), migration('0001_b', 40), migration('0002_low', 20), migration('0003_d', 50)];
    await applyFreshMigrations(fake.client, list);

    const last = [...fake.rows].sort((a, b) => b.created_at - a.created_at)[0];
    expect(last?.created_at).toBe(50);
    expect(list.filter((m) => last === undefined || last.created_at < m.folderMillis)).toEqual([]);
  });
});

describe('findUnrecordedMigrations', () => {
  it('returns nothing when every entry is recorded by hash or by created_at', async () => {
    const fake = fakeClient({
      tableExists: true,
      rows: [
        { hash: 'hash-0000_a', created_at: 10 },
        { hash: 'other-os-hash', created_at: 20 },
      ],
    });
    expect(await findUnrecordedMigrations(fake.client, [migration('0000_a', 10), migration('0001_b', 20)])).toEqual([]);
  });

  it('names an entry recorded neither way (a PR migration older than one already applied)', async () => {
    const fake = fakeClient({ tableExists: true, rows: [{ hash: 'hash-0001_new', created_at: 50 }] });
    const missing = await findUnrecordedMigrations(fake.client, [migration('0000_old', 40), migration('0001_new', 50)]);
    expect(missing).toEqual([{ tag: '0000_old', folderMillis: 40 }]);
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
    expect(() => attachJournalTags([{ sql: ['a'], folderMillis: 1, hash: 'h1' }], [])).toThrow(
      /1 migrations.*0 journal entries/,
    );
  });
});

describe('the real journal', () => {
  const journal = JSON.parse(
    readFileSync(resolve(__dirname, '../../../drizzle/migrations/meta/_journal.json'), 'utf-8'),
  ) as { entries: Array<{ tag: string; when: number }> };

  it('ends on its maximum `when`, so a later normal migrate() after fresh mode applies nothing', () => {
    expect(journal.entries.length).toBeGreaterThan(300);
    const max = Math.max(...journal.entries.map((e) => e.when));
    expect(journal.entries.at(-1)?.when).toBe(max);
  });

  it('has no duplicate `when` (the created_at resume rule would skip the second file)', () => {
    const whens = journal.entries.map((e) => e.when);
    expect(new Set(whens).size).toBe(whens.length);
  });
});

describe('disallowedUnrecorded (Phase 4 allow-list)', () => {
  // Literal, not derived from the constant, so an emptied allow-list cannot pass vacuously.
  const LEGACY = [
    '0110_f8_wave_k24_renewal_lapsed_enum',
    '0111_f8_phase6_us4_audit_event_type_enum',
    '0112_f8_phase6_review_cron_bearer_auth_rejected',
    '0113_f8_t149_fix_plan_id_at_cycle_start_text',
  ];
  const legacy = LEGACY.map((tag, i) => ({ tag, folderMillis: 1792224000001 + i }));

  it('lists exactly the four legacy F8 tags, each a real journal entry', () => {
    expect([...LEGACY_UNRECORDED_TAGS]).toEqual(LEGACY);
    const journal = JSON.parse(
      readFileSync(resolve(__dirname, '../../../drizzle/migrations/meta/_journal.json'), 'utf-8'),
    ) as { entries: Array<{ tag: string }> };
    const tags = new Set(journal.entries.map((e) => e.tag));
    expect(LEGACY_UNRECORDED_TAGS.every((t) => tags.has(t))).toBe(true);
  });

  it('normal mode: an unrecorded entry outside the allow-list still fails', () => {
    const other = { tag: '0200_something_new', folderMillis: 1795000000000 };
    expect(disallowedUnrecorded([...legacy, other], 'normal')).toEqual([other]);
  });

  it('normal mode: the four allow-listed entries pass', () => {
    expect(disallowedUnrecorded(legacy, 'normal')).toEqual([]);
  });

  it('fresh mode: the allow-list does not apply, every entry must be recorded', () => {
    expect(disallowedUnrecorded(legacy, 'fresh')).toEqual(legacy);
  });
});
