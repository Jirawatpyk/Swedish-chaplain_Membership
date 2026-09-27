/**
 * Every tenant-scoped table is either cleaned by `createTestTenant().cleanup()`
 * or explicitly excused here.
 *
 * WHY — `tests/integration/helpers/test-tenant.ts` holds a hand-written list of
 * DELETEs. A feature that adds a tenant-scoped table and forgets that list
 * leaks a row per test run, forever, and NOTHING fails: every call site does
 * `cleanup().catch(() => {})`, so even an FK error is swallowed. On 2026-09-27 a
 * sweep of the shared `dev` branch found **six** such tables — `export_jobs`
 * (62 rows), `broadcast_images` (51), `dashboard_metrics_cache` (34),
 * `tenant_image_source_allowlist` (23), `renewal_reminder_events` (8),
 * `renewal_escalation_tasks` (4) — and one of them was not merely untidy:
 * `renewal_escalation_tasks_cycle_fk` declares NO `onDelete`, so a single
 * escalation task BLOCKED the `renewal_cycles` delete, which blocked `members`
 * (RESTRICT), which stranded the whole tenant's rows.
 *
 * That litter is not free. Several crons are PLATFORM crons: they read a tenant
 * list out of a tenant-scoped table and sweep one tenant per round trip. 100
 * rows in `tenant_invoice_settings` (3 real) is ~21 s per sweep, which is what
 * timed out `redact-expired-member-invoices` at 60 s (PR #436).
 *
 * HOW — this reads the SOURCE (`information_schema` for the tables,
 * `test-tenant.ts` for the DELETEs, the drizzle schema files to map a symbol to
 * its table name) rather than any frozen fixture, so it keeps working as the
 * schema grows. Both parses carry a POSITIVE CONTROL: a check that cannot tell
 * "nothing to find" from "not looking" is not a check, and this repo has been
 * bitten by exactly that (`check:f8-error-id`, CLAUDE.md § Gotchas).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const HELPER = join(REPO_ROOT, 'tests', 'integration', 'helpers', 'test-tenant.ts');
const SRC = join(REPO_ROOT, 'src');

/**
 * Tables `cleanup()` deliberately does NOT delete. Each entry is a decision,
 * not a backlog item — state the reason so the next person does not "fix" it.
 */
const EXCUSED: ReadonlyMap<string, string> = new Map([
  [
    'audit_log',
    'append-only trigger BLOCKS DELETE by design; the rows are tenant-scoped and ' +
      'harmless. A disposable Neon branch is the real fix (see test-tenant.ts).',
  ],
]);

/** `export const foo = pgTable(\n? 'foo_table'` across the schema files. */
function symbolToTableName(): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      const text = readFileSync(full, 'utf8');
      // `\r?\n` — a `\n`-anchored regex is INERT on a CRLF checkout, which CI
      // (LF) can never catch. CLAUDE.md § Gotchas.
      const re = /export const (\w+) = pgTable\(\s*\r?\n?\s*'([a-z0-9_]+)'/g;
      for (const m of text.matchAll(re)) {
        map.set(m[1] as string, m[2] as string);
      }
    }
  };
  walk(SRC);
  return map;
}

/** Table names the helper issues a `db.delete(...)` for. */
function tablesCleanedByHelper(symbols: Map<string, string>): {
  readonly tables: Set<string>;
  readonly unresolved: string[];
  readonly deleteCount: number;
} {
  const text = readFileSync(HELPER, 'utf8');
  const matches = [...text.matchAll(/\.delete\((\w+)\)/g)].map((m) => m[1] as string);
  const tables = new Set<string>();
  const unresolved: string[] = [];
  for (const symbol of matches) {
    const table = symbols.get(symbol);
    if (table === undefined) unresolved.push(symbol);
    else tables.add(table);
  }
  return { tables, unresolved, deleteCount: matches.length };
}

describe('createTestTenant().cleanup() covers every tenant-scoped table', () => {
  it('parses its two sources at all (positive control)', () => {
    const symbols = symbolToTableName();
    // If the pgTable regex ever stops matching (a formatting change, a CRLF
    // anchor bug), every assertion below would pass by finding nothing.
    expect(
      symbols.size,
      'the pgTable parse found no tables — the regex is broken, not the schema',
    ).toBeGreaterThan(40);

    const { deleteCount, unresolved } = tablesCleanedByHelper(symbols);
    expect(
      deleteCount,
      'the .delete() parse found no DELETEs in test-tenant.ts — the regex is broken',
    ).toBeGreaterThan(20);
    // Every symbol the helper deletes must resolve to a real table, or the
    // coverage set below is quietly short.
    expect(unresolved, 'delete() symbols that resolve to no pgTable').toEqual([]);
  });

  it('leaves no tenant-scoped table uncleaned and unexcused', async () => {
    const rows = (await db.execute(sql`
      SELECT c.table_name AS name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public'
         AND c.column_name = 'tenant_id'
       ORDER BY c.table_name
    `)) as unknown as Array<{ name: string }>;
    const tenantScoped = rows.map((r) => r.name);
    // Positive control on the catalogue read too.
    expect(tenantScoped.length, 'no tenant-scoped tables found').toBeGreaterThan(30);

    const { tables: cleaned } = tablesCleanedByHelper(symbolToTableName());
    const uncovered = tenantScoped.filter((t) => !cleaned.has(t) && !EXCUSED.has(t));

    expect(
      uncovered,
      'These tables carry a tenant_id but createTestTenant().cleanup() never deletes ' +
        'them, so every test that writes one leaks a row — silently, because every ' +
        'call site swallows cleanup errors. Add the delete to ' +
        'tests/integration/helpers/test-tenant.ts (mind the FK order: a child with a ' +
        'NO ACTION FK blocks its parent), or add it to EXCUSED here with the reason.',
    ).toEqual([]);
  });

  it('excuses nothing that no longer exists', async () => {
    const rows = (await db.execute(sql`
      SELECT table_name AS name
        FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)) as unknown as Array<{ name: string }>;
    const existing = new Set(rows.map((r) => r.name));
    const stale = [...EXCUSED.keys()].filter((t) => !existing.has(t));
    expect(stale, 'EXCUSED names a table that has been dropped').toEqual([]);
  });
});
