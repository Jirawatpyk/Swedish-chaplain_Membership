/**
 * The e2e seeds were only ever run against prod-derived branches, where the
 * rows already existed. On the empty database the per-PR e2e run migrates
 * from zero (spec 123 slice 2), an INSERT that leaves out a NOT NULL column
 * without a database default fails — the first one found was
 * `seed-f4-invoice-settings` omitting `currency_code`.
 *
 * The seed scripts connect on import, so this reads the INSERT column list
 * from the source and checks it against the Drizzle table definition.
 *
 * `DB_HAS_NO_DEFAULT` lists columns where the Drizzle schema declares a
 * `.default()` that the migrations never created: the schema says it is safe
 * to omit, the database says it is not.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { tenantInvoiceSettings } from '@/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings';

/** Column names in the first `INSERT INTO <table> ( … )` of a seed's source. */
function insertColumns(seedFile: string, table: string): string[] {
  const source = readFileSync(resolve(__dirname, '../../../scripts', seedFile), 'utf-8');
  const match = new RegExp(`INSERT INTO\\s+"?${table}"?\\s*\\(([^)]*)\\)`, 'i').exec(source);
  if (match === null) throw new Error(`${seedFile}: no INSERT INTO ${table} (…)`);
  return match[1]!
    .split(',')
    .map((name) => name.trim().replace(/"/g, ''))
    .filter((name) => name.length > 0);
}

/** NOT NULL columns the INSERT must name: no default, or a default the DB lacks. */
function requiredColumns(table: Table, dbHasNoDefault: readonly string[]): string[] {
  return Object.values(getTableColumns(table))
    .filter((column) => column.notNull && (!column.hasDefault || dbHasNoDefault.includes(column.name)))
    .map((column) => column.name);
}

const CASES = [
  {
    seed: 'seed-f4-invoice-settings.ts',
    table: 'tenant_invoice_settings',
    drizzle: tenantInvoiceSettings,
    // 0026 adds currency_code, backfills 'THB' and sets NOT NULL, with no DEFAULT.
    dbHasNoDefault: ['currency_code'],
  },
] as const;

describe('seed INSERTs name every NOT NULL column the database cannot default', () => {
  it.each(CASES)('$seed → $table', ({ seed, table, drizzle, dbHasNoDefault }) => {
    const columns = insertColumns(seed, table);
    // Positive control: a parse that found nothing would pass any subset check.
    expect(columns.length).toBeGreaterThan(5);
    const required = requiredColumns(drizzle, dbHasNoDefault);
    expect(required.length).toBeGreaterThan(0);
    expect(required.filter((name) => !columns.includes(name))).toEqual([]);
  });
});
