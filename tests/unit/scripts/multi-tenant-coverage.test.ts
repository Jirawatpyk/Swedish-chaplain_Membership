/**
 * #400 PR-B item 9 — the positive control of `pnpm check:multi-tenant`
 * (`scripts/lib/multi-tenant-coverage.ts`).
 *
 * The readiness check audits an allow-list, so a `tenant_id` table nobody
 * registered was never checked and the gate said OK — fifteen were in that
 * state. The control parses every Drizzle table that declares `tenant_id` and
 * fails on one that is registered nowhere, and on a parse that found nothing
 * or missed a table known to exist.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_TENANT_TABLES,
  checkCoverage,
  parseTenantScopedTables,
  readSchemaSources,
  type CoverageLists,
} from '../../../scripts/lib/multi-tenant-coverage';

const table = (name: string, withTenant = true) =>
  `export const ${name} = pgTable(\n  '${name}',\n  {\n    id: uuid('id').primaryKey(),\n` +
  (withTenant ? `    tenantId: text('tenant_id').notNull(),\n` : '') +
  `  },\n);\n`;

const KNOWN = KNOWN_TENANT_TABLES.map((t) => table(t)).join('\n');
const LISTS: CoverageLists = { scoped: [...KNOWN_TENANT_TABLES], legacy: ['audit_log'], exempt: [] };

describe('parseTenantScopedTables', () => {
  it('finds every table that declares tenant_id, and only those — LF and CRLF alike', () => {
    const lf = `${table('members')}${table('rate_limit_state', false)}${table('audit_log')}`;
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseTenantScopedTables([{ path: 'a.ts', text: lf }])).toEqual(['audit_log', 'members']);
    expect(parseTenantScopedTables([{ path: 'a.ts', text: crlf }])).toEqual(['audit_log', 'members']);
  });

  it('ignores a tenant_id that only appears in a comment', () => {
    const text = `${table('users', false).replace("id: uuid('id')", "// tenant_id: 'tenant_id' is global here\n    id: uuid('id')")}`;
    expect(parseTenantScopedTables([{ path: 'a.ts', text }])).toEqual([]);
  });

  it('finds all the known tables in the real schema (the parse is not blind on this checkout)', () => {
    const parsed = parseTenantScopedTables(readSchemaSources(process.cwd()));
    for (const known of KNOWN_TENANT_TABLES) expect(parsed).toContain(known);
  });
});

describe('checkCoverage — the positive control', () => {
  it('passes when every parsed table is registered', () => {
    const parsed = parseTenantScopedTables([{ path: 'a.ts', text: `${KNOWN}${table('audit_log')}` }]);
    expect(checkCoverage(parsed, LISTS).failures).toEqual([]);
  });

  it('FAILS on a tenant_id table that is in none of the lists', () => {
    const parsed = parseTenantScopedTables([{ path: 'a.ts', text: `${KNOWN}${table('unlisted_widgets')}` }]);
    const { failures } = checkCoverage(parsed, LISTS);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('unlisted_widgets');
  });

  it('an EXEMPT entry registers a table, but only with a reason', () => {
    const parsed = parseTenantScopedTables([{ path: 'a.ts', text: `${KNOWN}${table('cache_rows')}` }]);
    expect(checkCoverage(parsed, { ...LISTS, exempt: [{ table: 'cache_rows', reason: 'derived, no PII' }] }).failures).toEqual([]);
    expect(checkCoverage(parsed, { ...LISTS, exempt: [{ table: 'cache_rows', reason: ' ' }] }).failures).toEqual([
      'EXEMPT entry `cache_rows` has no reason',
    ]);
  });

  it('FAILS when the parse found ZERO tables — a blind parse is not a clean schema', () => {
    const { failures } = checkCoverage(parseTenantScopedTables([]), LISTS);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ZERO');
  });

  it('FAILS when the parse missed a table known to exist', () => {
    const parsed = parseTenantScopedTables([{ path: 'a.ts', text: table('members') }]);
    const { failures } = checkCoverage(parsed, { ...LISTS, scoped: ['members'] });
    expect(failures.some((f) => f.includes('`broadcasts`'))).toBe(true);
  });
});
