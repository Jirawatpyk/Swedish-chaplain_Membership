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

describe('Billed — the billable statuses as a positive list', () => {
  it('reads issued | paid | partially_credited | credited, never a NOT IN', async () => {
    queries.length = 0;
    const range = { from: '2026-01-01', to: '2026-12-31' };
    await invoiceDashboardSourceAdapter.monthlyBilledCollected(CTX, FILTERS, range, range);
    const text = queries[0]?.sql ?? '';
    // Positive control: the Billed invoice term and its credit-note term are both there.
    const billable = text.match(
      /"invoices"\."status" IN \('issued', 'paid', 'partially_credited', 'credited'\)/g,
    );
    expect(billable).toHaveLength(2);
    expect(text).not.toMatch(/NOT IN/);
  });
});

/**
 * Principle I, the second wall: every table reference after FROM / JOIN —
 * CTE bodies, subqueries and the `later_attempt` alias included — carries its
 * own `"<name>"."tenant_id" = $n` predicate. Counted per reference, so a
 * predicate dropped from one UNION branch of a table read four times fails.
 * Drizzle quotes table names; CTE names (`terms`, `invoice_pass`, …) are bare,
 * so they are not table references.
 */
const TABLE_REF = /\b(?:FROM|JOIN)\s+"([a-z_]+)"(?:\s+(?:AS\s+)?"([a-z_]+)")?/g;

function tenancyViolations(text: string): { refs: string[]; tables: Set<string>; violations: string[] } {
  const refs: string[] = [];
  const tables = new Set<string>();
  for (const m of text.matchAll(TABLE_REF)) {
    tables.add(m[1]!);
    refs.push(m[2] ?? m[1]!);
  }
  const violations: string[] = [];
  for (const ref of new Set(refs)) {
    const uses = refs.filter((r) => r === ref).length;
    const fenced = text.match(new RegExp(String.raw`"${ref}"\."tenant_id" = \$\d+`, 'g'))?.length ?? 0;
    if (fenced < uses) violations.push(`${ref}: ${uses} reference(s), ${fenced} tenant predicate(s)`);
  }
  // A comma join would hide its second table from the parse above.
  if (/\b(?:FROM|JOIN)\s+"[a-z_]+"(?:\s+(?:AS\s+)?"[a-z_]+")?\s*,/.test(text)) {
    violations.push('comma join after a table reference');
  }
  return { refs, tables, violations };
}

describe('tenancy — every table reference carries its own tenant_id predicate', () => {
  it('the checker itself: a statement missing one predicate is caught (negative control)', () => {
    const bad = `SELECT 1 FROM "invoices" WHERE "invoices"."tenant_id" = $1
      UNION ALL SELECT 1 FROM "invoices" WHERE "invoices"."status" = 'paid'`;
    expect(tenancyViolations(bad).violations).toEqual(['invoices: 2 reference(s), 1 tenant predicate(s)']);
    expect(tenancyViolations(`SELECT 1 FROM "refunds" AS "later_attempt"`).violations).toEqual([
      'later_attempt: 1 reference(s), 0 tenant predicate(s)',
    ]);
  });

  it('all eight adapter statements', async () => {
    queries.length = 0;
    const range = { from: '2026-01-01', to: '2026-06-15' };
    const a = invoiceDashboardSourceAdapter;
    await a.outstandingByAgingBucket(CTX, FILTERS, '2026-06-15');
    await a.collectedInRange(CTX, FILTERS, range);
    await a.collectedByMethod(CTX, FILTERS, range);
    await a.monthlyBilledCollected(CTX, FILTERS, range, range);
    await a.attentionCounts(CTX, FILTERS, new Date('2026-06-15T05:00:00Z'));
    await a.oldestOverdue(CTX, FILTERS, '2026-06-15', 6);
    await a.hasNonDraftInvoice(CTX);
    await a.draftCount(CTX, FILTERS);
    expect(queries).toHaveLength(8);

    const allTables = new Set<string>();
    const allRefs: string[] = [];
    for (const { sql: text } of queries) {
      const { refs, tables, violations } = tenancyViolations(text);
      // Positive control: each statement's parse finds at least one table.
      expect(refs.length).toBeGreaterThan(0);
      expect(violations).toEqual([]);
      for (const t of tables) allTables.add(t);
      allRefs.push(...refs);
    }
    // Positive control: the parse sees every money table and the alias.
    // `events` (124 follow-up): Oldest overdue names an event invoice by its event.
    expect([...allTables].sort()).toEqual(['credit_notes', 'events', 'invoices', 'payments', 'refunds']);
    expect(allRefs).toContain('later_attempt');
  });
});
