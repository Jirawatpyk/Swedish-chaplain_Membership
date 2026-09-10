/**
 * T205 + T207 + T208 (Phase 10) — F7 EXPLAIN ANALYZE checks for the
 * three hottest broadcast queries.
 *
 *   - T205: suppression lookup batched as `email = ANY($1)` (single
 *           index probe, NOT N+1)
 *   - T207: segment resolver `(tenant_id, plan_id)` index hit
 *   - T208: RLS overhead ≤ 5 ms p95 on the 5 hottest queries
 *
 * Live-Neon required. Skipped automatically when DATABASE_URL absent.
 */
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

const TENANT_SLUG = 'test-suppression-explain';
const tenantCtx = asTenantContext(TENANT_SLUG);

async function requireDb(): Promise<ReturnType<typeof postgres> | null> {
  if (!process.env.DATABASE_URL) return null;
  return postgres(process.env.DATABASE_URL, { ssl: 'require', max: 1 });
}

describe('T205 — suppression lookup is single batched query', () => {
  it.skipIf(!process.env.DATABASE_URL)(
    'EXPLAIN: lookupBatch uses Index Scan on marketing_unsubscribes_pkey',
    async () => {
      const result = (await runInTenant(tenantCtx, async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = OFF`);
        return tx.execute(sql`
          EXPLAIN (FORMAT JSON, ANALYZE)
          SELECT email_lower
            FROM marketing_unsubscribes
           WHERE tenant_id = ${TENANT_SLUG}
             AND email_lower = ANY(ARRAY['probe-1@example.com','probe-2@example.com']::text[])
        `);
      })) as unknown as Array<{ 'QUERY PLAN': unknown }>;
      const planJson = JSON.stringify(result);
      // Plan should NOT contain Nested Loop (= N+1 antipattern).
      expect(planJson).not.toMatch(/Nested Loop/i);
      // Plan should reference an index — pkey OR a tenant-scoped index.
      const usesIndex =
        planJson.includes('Index Scan') ||
        planJson.includes('Index Only Scan') ||
        planJson.includes('Bitmap Index Scan');
      expect(usesIndex).toBe(true);
    },
  );
});

describe('T207 — segment resolver uses tenant+plan index', () => {
  it.skipIf(!process.env.DATABASE_URL)(
    'EXPLAIN: members tenant+plan filter does not Seq Scan',
    async () => {
      // Schema note: `primary_contact_email` is derived via contacts
      // join — query the canonical (tenant_id, status, plan_id) shape
      // used by `getMembersBySegment` repo method instead.
      const result = (await runInTenant(tenantCtx, async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = OFF`);
        return tx.execute(sql`
          EXPLAIN (FORMAT JSON, ANALYZE)
          SELECT member_id
            FROM members
           WHERE tenant_id = ${TENANT_SLUG}
             AND plan_id = 'test-plan-stub'
        `);
      })) as unknown as Array<{ 'QUERY PLAN': unknown }>;
      const planJson = JSON.stringify(result);
      expect(planJson).not.toMatch(/Seq Scan on members/i);
    },
  );
});

describe('T208 — RLS overhead bounded ≤ 5ms p95', () => {
  it.skipIf(!process.env.DATABASE_URL)(
    'tenant-bound query latency stays within budget on a small table',
    async () => {
      // REWRITTEN 2026-09-08 — this measured wall clock and could not detect
      // what its own name promises.
      //
      // `runInTenant` is a TRANSACTION: BEGIN + `SET LOCAL app.current_tenant`
      // + the query + COMMIT. Measured from a Bangkok workstation against Neon
      // Singapore: a bare `SELECT 1` (one round trip) is 40 ms mean, and the
      // `runInTenant` block is 185 ms mean / 215 ms p95 — a ratio of 4.6, i.e.
      // the round trips, not the database. The old comment sized the budget as
      // "25 ms × 1 query", one round trip, so 200 ms landed in the middle of
      // the noise band and the case passed or failed with the day's latency.
      // It failed three runs in a row on 2026-09-08 at 220–232 ms, with no
      // change to any query.
      //
      // Worse than flaky: RLS overhead is ~0.05 ms here, so a 5 ms regression —
      // the thing this case is named for — is invisible inside 185 ms of
      // network. It was a latency thermometer wearing an RLS label.
      //
      // So assert on the SERVER's own execution time, which excludes the
      // network entirely and is therefore the same number on any machine. The
      // EXPLAIN-based technique is already used by the case above in this file.
      // A budget of 5 ms now means what the name says; today it measures
      // 0.035–0.062 ms, so the headroom is ~80×. This WOULD catch a policy
      // rewrite that turns the tenant filter into a Seq Scan or drags a
      // subquery into the RLS predicate — the regression class that matters.
      const samples: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        const rows = (await runInTenant(tenantCtx, async (tx) =>
          tx.execute(sql`
            EXPLAIN (FORMAT JSON, ANALYZE)
            SELECT 1 FROM members WHERE tenant_id = ${TENANT_SLUG} LIMIT 1
          `),
        )) as unknown as Array<{ 'QUERY PLAN': Array<Record<string, unknown>> }>;
        const executionMs = Number(rows[0]?.['QUERY PLAN']?.[0]?.['Execution Time'] ?? NaN);
        expect(Number.isFinite(executionMs)).toBe(true);
        samples.push(executionMs);
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      // Server-side execution only — no network in this number. The env
      // override stays for a loaded CI box, not for a slow link.
      expect(p95).toBeLessThan(Number(process.env.PERF_RLS_P95_MS ?? '5'));
    },
  );
});

afterAll(async () => {
  const dbm = await requireDb();
  if (dbm) await dbm.end();
});
