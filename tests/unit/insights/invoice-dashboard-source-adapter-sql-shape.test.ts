/**
 * 124 invoice dashboard — the SQL shape of `collectedByMethod`: every
 * Collected term lands on a method row, so the six rows add up to Collected
 * in FY (spec US1). A waived refund takes its own payment's method, else
 * falls back like the invoice terms (latest method payment, else
 * `invoices.payment_method`); no term is ever dropped.
 *
 * Why a shape test: `refunds.payment_id` is a NOT NULL FK to `payments.id`
 * (migration 0034) and the own-payment lookup has no status filter, so a
 * waived refund whose payment row is missing cannot be seeded on live Neon.
 * The figures themselves are proven in
 * `tests/integration/insights/invoice-dashboard-figures.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const statements: string[] = [];
const queries: { sql: string; params: unknown[] }[] = [];

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: vi.fn(async (q: SQL) => {
        const query = new PgDialect().sqlToQuery(q);
        statements.push(query.sql);
        queries.push({ sql: query.sql, params: query.params });
        // One row every mapper can parse (the figures are proven on live Neon).
        return [{ amount: '0', n: 0, billed: '0', collected: '0', month: '2026-01' }];
      }),
    }),
  ),
}));

const { invoiceDashboardSourceAdapter } = await import(
  '@/modules/insights/infrastructure/sources/invoice-dashboard-source-adapter'
);

const CTX = { slug: 'tenant-shape' } as never;
const FILTERS = { type: 'all', fiscalYear: 2026, planId: null, origin: 'all' } as const;

describe('collectedByMethod — SQL shape', () => {
  it('never drops a waived-refund term: own payment method, else the invoice fallback chain', async () => {
    statements.length = 0;
    await invoiceDashboardSourceAdapter.collectedByMethod(CTX, FILTERS, {
      from: '2026-01-01',
      to: '2026-06-15',
    });

    expect(statements).toHaveLength(1);
    const text = statements[0] ?? '';
    // Positive control: the waived-refund term is in the statement at all.
    expect(text).toContain("'waived_refund'");
    // No predicate singles the waived-refund term out — not as a row drop,
    // not as a narrowing of the latest-method lookup.
    expect(text).not.toContain("<> 'waived_refund'");
    expect(text).toMatch(
      /COALESCE\(own_method\.method,\s*latest_method\.method,\s*terms\.invoice_payment_method\)/,
    );
  });
});

describe('the waived-refund term — a leakproof, index-usable completed_at range', () => {
  it('bounds completed_at by Bangkok-midnight instants computed in the app, half-open', async () => {
    queries.length = 0;
    await invoiceDashboardSourceAdapter.collectedInRange(CTX, FILTERS, {
      from: '2026-04-01',
      to: '2026-04-30',
    });
    const { sql: text, params } = queries[0] ?? { sql: '', params: [] };
    const range = text.match(
      /"refunds"\."completed_at" >= \$(\d+)::timestamptz AND "refunds"\."completed_at" < \$(\d+)::timestamptz/,
    );
    expect(range).not.toBeNull();
    expect(params[Number(range?.[1]) - 1]).toBe('2026-04-01T00:00:00+07:00');
    // The day after `to`, so 2026-04-30T23:30Z (= 1 May in Bangkok) stays out.
    expect(params[Number(range?.[2]) - 1]).toBe('2026-05-01T00:00:00+07:00');
    // The Bangkok date is only the grouping column, never the range predicate
    // (timezone() is not leakproof, so under RLS it can never be an index condition).
    expect(text).not.toMatch(/\("refunds"\."completed_at" AT TIME ZONE 'Asia\/Bangkok'\)::date\) >=/);
  });
});
