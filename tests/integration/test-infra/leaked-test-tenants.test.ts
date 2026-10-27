/**
 * 135 — the stale test-tenant sweep the integration globalSetup runs.
 *
 * Integration runs leak `test-*` tenants: a worker dies before `afterAll`, or a
 * `cleanup()` fails and is swallowed. Platform crons enumerate every tenant,
 * so each leaked one slows them; on 2026-10-27 the shared dev branch held 168
 * and the redact crons timed out under the pre-push hook. The sweep removes
 * the rows of test tenants whose newest row is older than the age filter.
 *
 * Every call here is scoped with `onlySlugs` to the tenants this file
 * creates, so it never touches another run's fixtures on the shared branch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import {
  GENERATED_TEST_SLUG,
  sweepLeakedTestTenants,
} from '../../../scripts/lib/leaked-test-tenants';

const url =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;

describe('sweepLeakedTestTenants (135) — live Neon dev', () => {
  let sql: postgres.Sql;
  // Hex suffixes like `createTestTenant`'s, and 2 h old at most: any other
  // run's globalSetup sweeps only rows older than 6 h, so it never takes
  // these between `beforeAll` and the assertions.
  const stale = `test-sweep-${randomUUID().slice(0, 8)}`;
  const fresh = `test-sweep-${randomUUID().slice(0, 8)}`;
  const fixed = 'test-sweep-fixed-slug';
  const budgetA = `test-sweep-${randomUUID().slice(0, 8)}`;
  const budgetB = `test-sweep-${randomUUID().slice(0, 8)}`;
  const notTest = `testing-${randomUUID().slice(0, 8)}`;

  async function seed(slug: string, ageHours: number): Promise<void> {
    await sql`
      INSERT INTO tenant_document_sequences (tenant_id, document_type, fiscal_year, created_at, updated_at)
      VALUES (${slug}, 'bill', 2026, now() - make_interval(hours => ${ageHours}), now() - make_interval(hours => ${ageHours}))
      ON CONFLICT DO NOTHING
    `;
    // A table with no created_at: dated by the tenant's other rows.
    await sql`
      INSERT INTO dashboard_metrics_cache (tenant_id, metrics, computed_at)
      VALUES (${slug}, '{}'::jsonb, now())
      ON CONFLICT DO NOTHING
    `;
  }

  async function owned(slug: string): Promise<number> {
    const [a] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tenant_document_sequences WHERE tenant_id = ${slug}`;
    const [b] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM dashboard_metrics_cache WHERE tenant_id = ${slug}`;
    return (a?.n ?? 0) + (b?.n ?? 0);
  }

  beforeAll(async () => {
    sql = postgres(url!, { ssl: 'require', max: 2 });
    await seed(stale, 2);
    await seed(fresh, 0);
    await seed(fixed, 2);
    await seed(notTest, 2);
    await seed(budgetA, 2);
    await seed(budgetB, 2);
  });

  afterAll(async () => {
    for (const slug of [stale, fresh, fixed, notTest, budgetA, budgetB]) {
      await sql`DELETE FROM tenant_document_sequences WHERE tenant_id = ${slug}`;
      await sql`DELETE FROM dashboard_metrics_cache WHERE tenant_id = ${slug}`;
    }
    await sql.end({ timeout: 5 });
  });

  it('a dry run reports the stale tenant as eligible and deletes nothing', async () => {
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 1,
      apply: false,
      includeUndatable: false,
      allowTriggerDisable: false,
      onlySlugs: [stale, fresh],
    });
    expect(report.eligible).toEqual([stale]);
    expect(report.tooRecent).toEqual([fresh]);
    expect(await owned(stale)).toBe(2);
  });

  it('a spent time budget drains one tenant and leaves the rest for the next run', async () => {
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 1,
      apply: true,
      includeUndatable: false,
      allowTriggerDisable: false,
      onlySlugs: [budgetA, budgetB],
      budgetMs: 0,
    });
    expect(report.fullyCleaned).toBe(1);
    expect(report.skippedBudget).toHaveLength(1);
    expect((await owned(budgetA)) + (await owned(budgetB))).toBe(2);
  });

  it('a slug pattern keeps fixed-slug fixtures out of the automatic sweep', async () => {
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 1,
      apply: false,
      includeUndatable: false,
      allowTriggerDisable: false,
      onlySlugs: [stale, fixed],
      slugPattern: GENERATED_TEST_SLUG,
    });
    expect(report.eligible).toEqual([stale]);
  });

  it('apply removes every row of the stale tenant and leaves the fresh one', async () => {
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 1,
      apply: true,
      includeUndatable: false,
      allowTriggerDisable: false,
      onlySlugs: [stale, fresh],
    });
    expect(report.fullyCleaned).toBe(1);
    expect(report.stuck).toEqual([]);
    expect(await owned(stale)).toBe(0);
    expect(await owned(fresh)).toBe(2);
  });

  it('a slug that only looks like a test slug is never a candidate', async () => {
    // `testing-…` passes the SQL `LIKE 'test%'` prefilter; the slug regex
    // must reject it.
    const report = await sweepLeakedTestTenants(sql, {
      maxAgeHours: 0,
      apply: false,
      includeUndatable: true,
      allowTriggerDisable: false,
      onlySlugs: [notTest, fresh],
    });
    expect(report.eligible).toEqual([fresh]);
  });
});
