/**
 * 124 slice 2 — the tax-point expression index (migration 0318) and the
 * query expression it serves can never drift apart.
 *
 * Postgres uses an expression index only when the query's expression matches
 * the indexed one. The register, the CSV export and the invoice dashboard all
 * read `invoiceTaxPointSql` from the invoicing barrel; migration 0318 indexes
 * the same text. This guard renders the exported SQL the way an index renders
 * it (bare column names) and asserts the migration file carries exactly that
 * expression, whitespace-normalised (which also absorbs CRLF checkouts).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { invoiceTaxPointSql } from '@/modules/invoicing';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function migration0318(): string {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^0318_.*\.sql$/.test(f));
  // Positive control: a missing or duplicated 0318 file must fail here, not
  // pass vacuously.
  expect(files).toHaveLength(1);
  return readFileSync(join(MIGRATIONS_DIR, files[0] as string), 'utf8');
}

describe('invoiceTaxPointSql ↔ migration 0318 index', () => {
  const rendered = new PgDialect().sqlToQuery(invoiceTaxPointSql, 'indexes');

  it('renders as a parameter-free expression (an index cannot take parameters)', () => {
    expect(rendered.params).toEqual([]);
    expect(rendered.sql).toContain('COALESCE(');
    expect(rendered.sql).toContain("AT TIME ZONE 'Asia/Bangkok'");
  });

  it('migration 0318 indexes exactly the exported expression', () => {
    expect(normalise(migration0318())).toContain(normalise(rendered.sql));
  });
});
