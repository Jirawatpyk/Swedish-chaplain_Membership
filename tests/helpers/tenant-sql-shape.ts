/**
 * 130 (D-029) — Principle I's application wall, checked on the SQL a repo
 * actually sends. Every reference to a tenant-scoped table must carry its own
 * `tenant_id` predicate, so a repo stays isolated even if RLS is bypassed.
 *
 * `recordingDb()` is a Drizzle `pg-proxy` database: builder queries and
 * `execute(sql``)` both reach its callback as final SQL text, which it records
 * and answers with no rows. The proxy driver has no transactions, so a test
 * hands the db itself to a repo as its `tx`.
 *
 * The parser handles both styles the repos use: Drizzle's builder (quoted,
 * qualified, lowercase keywords) and hand-written SQL (bare names, aliases).
 * Only names in `tenantTables` count, so CTEs, subqueries and set-returning
 * functions are ignored without special cases.
 *
 * Known limit (D-029): predicates are counted, not placed — one inside an OR
 * branch still counts. Review a statement with OR around a tenant predicate
 * by hand.
 */
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pg-proxy';

export const SHAPE_TENANT = 'tenant-shape';

/**
 * Every table with a `tenant_id` column, read from the Drizzle schemas
 * themselves (`/src/modules/**\/schema*.ts`, checked against every `pgTable(`
 * file), so a new table is covered without anyone listing it.
 */
export function tenantScopedTables(): string[] {
  // @ts-expect-error — `import.meta.glob` is a Vite transform; `vite/client`
  // is not resolvable from the repo root under pnpm (same as
  // tests/unit/broadcast/eblast-error-boundaries.test.tsx). Keep it literal.
  const modules = import.meta.glob('/src/modules/**/schema*.ts', { eager: true }) as Record<
    string,
    Record<string, unknown>
  >;
  const names = new Set<string>();
  for (const mod of Object.values(modules)) {
    for (const value of Object.values(mod)) {
      if (!is(value, PgTable)) continue;
      const config = getTableConfig(value);
      if (config.columns.some((c) => c.name === 'tenant_id')) names.add(config.name);
    }
  }
  return [...names].sort();
}

export type RecordedStatement = { sql: string; params: unknown[] };

export function recordingDb(): { db: ReturnType<typeof drizzle>; statements: RecordedStatement[] } {
  const statements: RecordedStatement[] = [];
  const db = drizzle(async (sql, params) => {
    statements.push({ sql, params });
    return { rows: [] };
  });
  return { db, statements };
}

const TABLE_REF =
  /\b(from|join|update)\s+("?)([a-z_][a-z0-9_]*)\2(?:\s+(?:as\s+)?("?)([a-z_][a-z0-9_]*)\4)?/gi;

// A word after a table name that is SQL, not an alias.
const NOT_AN_ALIAS = new Set([
  'where', 'set', 'on', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'join', 'order',
  'group', 'limit', 'offset', 'for', 'returning', 'using', 'union', 'having', 'window', 'and',
  'or', 'except', 'intersect', 'lateral',
]);

export type TenancyCheck = { refs: string[]; tables: Set<string>; violations: string[] };

/**
 * `statement` is the recorded SQL, or bare text for the checker's own tests.
 * With params, a bound predicate counts only when its `$n` IS the tenant.
 */
export function tenantPredicateViolations(
  statement: string | RecordedStatement,
  tenantTables: readonly string[],
  tenant: string = SHAPE_TENANT,
): TenancyCheck {
  const text = typeof statement === 'string' ? statement : statement.sql;
  const params = typeof statement === 'string' ? null : statement.params;
  const isTenant = (n: string) => params === null || params[Number(n) - 1] === tenant;

  const scoped = new Set(tenantTables);
  const refs: string[] = [];
  const tables = new Set<string>();
  for (const m of text.matchAll(TABLE_REF)) {
    const table = m[3]!.toLowerCase();
    if (!scoped.has(table)) continue;
    const alias = m[5]?.toLowerCase();
    tables.add(table);
    refs.push(alias && !NOT_AN_ALIAS.has(alias) ? alias : table);
  }

  const col = (ref: string) => String.raw`(?<![\w."])"?${ref}"?\."?tenant_id"?`;
  const uses = (ref: string) => refs.filter((r) => r === ref).length;
  const bound = (ref: string) =>
    [...text.matchAll(new RegExp(String.raw`${col(ref)}\s*=\s*\$(\d+)`, 'gi'))].filter((m) => isTenant(m[1]!))
      .length;

  const correlated = (ref: string, other: string) =>
    text.match(
      new RegExp(String.raw`${col(ref)}\s*=\s*${col(other)}|${col(other)}\s*=\s*${col(ref)}`, 'gi'),
    )?.length ?? 0;
  const bare = () =>
    // A single-table, single-SELECT statement may name the column bare.
    refs.length === 1 && (text.match(/\bselect\b/gi)?.length ?? 0) <= 1
      ? [...text.matchAll(/(?<![."\w])"?tenant_id"?\s*=\s*\$(\d+)/gi)].filter((m) => isTenant(m[1]!)).length
      : 0;
  // A ref is fenced by a bound tenant parameter, or by a join correlated to a
  // DIFFERENT ref that is itself fenced — resolved to a fixpoint, so a chain
  // (credit_notes → linked_invoice → renewal_cycles = $1) holds while a ring
  // with no bound tenant (a = b, b = a) never does.
  const distinct = [...new Set(refs)];
  const count = (ref: string, fenced: ReadonlySet<string>) =>
    bound(ref) + bare() + [...fenced].filter((o) => o !== ref).reduce((n, o) => n + correlated(ref, o), 0);
  const fenced = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const ref of distinct) {
      if (!fenced.has(ref) && count(ref, fenced) >= uses(ref)) {
        fenced.add(ref);
        grew = true;
      }
    }
  }
  const violations: string[] = [];
  for (const ref of distinct) {
    if (!fenced.has(ref)) {
      violations.push(`${ref}: ${uses(ref)} reference(s), ${count(ref, fenced)} tenant predicate(s)`);
    }
  }
  // A comma join would hide its second table from the parse above.
  if (/\b(?:from|join)\s+"?[a-z_][a-z0-9_]*"?(?:\s+(?:as\s+)?"?[a-z_][a-z0-9_]*"?)?\s*,/i.test(text)) {
    violations.push('comma join after a table reference');
  }
  return { refs, tables, violations };
}

/**
 * A stand-in for any argument: every property reads as an ISO-ish string, so
 * ids, dates and limits all render as bound params; a tenant field reads as
 * `SHAPE_TENANT`, the slug the test builds the repo with.
 */
export const ANY: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
  get: (_t, key) => {
    if (key === 'then' || typeof key === 'symbol') return undefined;
    // Adapters refuse an input whose tenant differs from their own context.
    if (key === 'tenantId' || key === 'tenantSlug') return SHAPE_TENANT;
    return '2026-01-01T00:00:00.000Z';
  },
});

/** `ANY` with a few fields pinned (a null cursor, a numeric page size, …). */
export function anyWith(fields: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(fields, {
    get: (t, key) => (typeof key === 'string' && key in t ? t[key] : ANY[key as string]),
  });
}

/**
 * Calls each named method with its args and swallows what an empty result
 * makes it throw — the SQL is recorded before any mapper runs. Throws when
 * the repo has a method the calls do not name, so a new method cannot ship
 * unchecked.
 */
export async function callEach(
  target: Record<string, unknown>,
  calls: Record<string, readonly unknown[]>,
): Promise<void> {
  const unnamed = Object.keys(target).filter((k) => typeof target[k] === 'function' && !(k in calls));
  if (unnamed.length > 0) throw new Error(`gate does not call: ${unnamed.join(', ')}`);
  for (const [name, args] of Object.entries(calls)) {
    const fn = target[name];
    if (typeof fn !== 'function') throw new Error(`no method ${name}`);
    try {
      await (fn as (...a: unknown[]) => Promise<unknown>).apply(target, [...args]);
    } catch {
      // An empty result set — fine for a shape check.
    }
  }
}

/** A pure `insert ... values` statement: tenant_id is in VALUES, nothing is read. */
export function isPureInsert(sql: string): boolean {
  return /^\s*insert\b/i.test(sql) && !/\b(?:select|where)\b/i.test(sql);
}
