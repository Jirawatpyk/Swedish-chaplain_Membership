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

vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: vi.fn(async (q: SQL) => {
        statements.push(new PgDialect().sqlToQuery(q).sql);
        return [];
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
