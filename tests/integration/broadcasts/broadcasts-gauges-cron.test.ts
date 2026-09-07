/**
 * 108 PR-D staff review P4.1 — the gauges cron against live Neon.
 *
 * Why this file exists: the pre-push route gate printed
 *
 *   [pre-push] no integration test imports
 *   src/app/api/internal/metrics/broadcasts-gauges/route.ts — skipping
 *
 * on the very push that added a FOURTH SQL query to that route (the
 * `broadcasts.suppression_list_size` gauge over `marketing_unsubscribes`). Its
 * only other coverage is `tests/contract/broadcasts/cron-broadcasts-gauges.contract.test.ts`,
 * which mocks `db.transaction` wholesale and hands back canned rows — so it
 * pins the WIRING (which gauge families are emitted, what the summary looks
 * like) and can say nothing about whether the SQL is valid. A wrong table or
 * column name would have 500'd this cron every five minutes in production with
 * every gate green: the `void-pdf-reconcile` shape, one more time.
 *
 * This drives the exported `GET` with a real Bearer token against the live
 * Neon `dev` branch. The assertion is deliberately about REACHING the summary,
 * not about the numbers — other tenants' rows are in that branch and the
 * counts are not this test's business.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { runInTenant } from '@/lib/db';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

import { GET as gaugesGet } from '@/app/api/internal/metrics/broadcasts-gauges/route';

let tenant: TestTenant;
const originalSecret = process.env.CRON_SECRET;
const SECRET = `test-cron-secret-${randomUUID()}`;

beforeAll(async () => {
  tenant = await createTestTenant('test-swecham');
  process.env.CRON_SECRET = SECRET;
  // One suppression row, so the new query has something of ours to count.
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(marketingUnsubscribes).values({
      tenantId: tenant.ctx.slug,
      emailLower: `gauge-${randomUUID().slice(0, 8)}@example.test`,
      reason: 'admin_added',
    }),
  );
}, 120_000);

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalSecret;
  await tenant?.cleanup().catch(() => {});
}, 120_000);

function req(token: string): NextRequest {
  return new NextRequest('http://localhost:3100/api/internal/metrics/broadcasts-gauges', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, 'x-tenant': tenant.ctx.slug },
  });
}

describe('108 PR-D — broadcasts-gauges cron on live Neon (staff review P4.1)', () => {
  it('all five gauge queries execute and the route returns its summary', async () => {
    const res = await gaugesGet(req(SECRET));
    // A 500 here means one of the five statements is invalid against the real
    // schema — which is the only thing this file exists to catch.
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('error');
  });

  it('a wrong bearer is refused before any query runs', async () => {
    const res = await gaugesGet(req('not-the-secret'));
    expect(res.status).toBe(401);
  });
});
