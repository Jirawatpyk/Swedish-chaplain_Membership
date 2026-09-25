/**
 * #400 PR-B item 9 — the positive control of `pnpm check:multi-tenant`
 * (`scripts/lib/multi-tenant-coverage.ts`).
 *
 * The readiness check audits an allow-list, so a `tenant_id` table nobody
 * registered was never checked and the gate said OK — fifteen were in that
 * state. The control parses every Drizzle table that declares `tenant_id` and
 * fails on one that is registered nowhere, and on a parse that found nothing
 * or missed a table known to exist.
 *
 * #400 W1 — nothing ran that control (no hook, no CI job: the script needs a
 * database). The lists now live in `scripts/lib/multi-tenant-registry.ts`, and
 * the REAL schema is checked against the REAL lists here, in the unit suite
 * CI already runs. W4 — a `pgTable(` whose name is not a string literal was
 * skipped silently; it is now a failure.
 */
import { describe, expect, it } from 'vitest';
import {
  KNOWN_TENANT_TABLES,
  checkCoverage,
  parseTenantScopedTables,
  readSchemaSources,
  type CoverageLists,
} from '../../../scripts/lib/multi-tenant-coverage';
import { EXEMPT, LEGACY_KNOWN_GAPS, SCOPED_TABLES } from '../../../scripts/lib/multi-tenant-registry';

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
    expect(parseTenantScopedTables([{ path: 'a.ts', text: lf }]).tables).toEqual(['audit_log', 'members']);
    expect(parseTenantScopedTables([{ path: 'a.ts', text: crlf }]).tables).toEqual(['audit_log', 'members']);
  });

  it('ignores a tenant_id that only appears in a comment', () => {
    const text = `${table('users', false).replace("id: uuid('id')", "// tenant_id: 'tenant_id' is global here\n    id: uuid('id')")}`;
    expect(parseTenantScopedTables([{ path: 'a.ts', text }]).tables).toEqual([]);
  });

  it('finds all the known tables in the real schema (the parse is not blind on this checkout)', () => {
    const parsed = parseTenantScopedTables(readSchemaSources(process.cwd()));
    for (const known of KNOWN_TENANT_TABLES) expect(parsed.tables).toContain(known);
  });
});

describe('the REAL schema against the REAL registry (#400 W1 — the gate CI actually runs)', () => {
  it('every tenant_id table in src/modules/**/infrastructure is registered, and the parse is not blind', () => {
    const parsed = parseTenantScopedTables(readSchemaSources(process.cwd()));
    const { failures } = checkCoverage(parsed, { scoped: SCOPED_TABLES, legacy: LEGACY_KNOWN_GAPS, exempt: EXEMPT });
    expect(failures).toEqual([]);
    expect(parsed.tables.length).toBeGreaterThan(KNOWN_TENANT_TABLES.length);
  });
});

describe('a pgTable( whose name is not a string literal (#400 W4)', () => {
  it('FAILS when it declares tenant_id — it cannot be matched against the registry', () => {
    const text = "export const widgets = pgTable(WIDGETS_TABLE, {\n  tenantId: text('tenant_id').notNull(),\n});\n";
    const { failures } = checkCoverage(parseTenantScopedTables([{ path: 'src/x.ts', text: `${KNOWN}${text}` }]), LISTS);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('src/x.ts');
    expect(failures[0]).toContain('string literal');
  });

  it('is ignored when it declares no tenant_id (not the control\'s business)', () => {
    const text = "export const globals = pgTable(GLOBALS_TABLE, {\n  id: uuid('id'),\n});\n";
    expect(checkCoverage(parseTenantScopedTables([{ path: 'src/x.ts', text: `${KNOWN}${text}` }]), LISTS).failures).toEqual([]);
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
