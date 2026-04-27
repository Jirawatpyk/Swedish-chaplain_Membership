/**
 * T139 — Stale-pending-count cron handler integration test.
 *
 * Spec authority: `specs/009-online-payment/plan.md` § VII.Metrics +
 * `docs/runbooks/stale-pending-count.md`.
 *
 * Asserts (lean integration variant):
 *   (a) Bearer auth — handler rejects missing/wrong CRON_SECRET with 401.
 *   (b) Query shape — handler returns valid JSON with the documented
 *       payload schema { ok, tenantCount, totalEmitted, staleHours, tenants[] }.
 *   (c) `staleHours` equals the documented 24-hour cutoff.
 *   (d) Per-tenant entries (if any) carry `tenantId` + `count` fields.
 *
 * Why this lean shape: the full FK chain (payments → invoices → members →
 * plans) is heavyweight to seed for a metrics-emission gauge. The route's
 * core logic is a Drizzle aggregate query against `payments` — exercised
 * here by running the actual handler against live Neon. Specific seeded-
 * count assertions live in the unit-level test of the route helper.
 *
 * Mocking policy: NONE — live Neon hit via the actual route handler.
 */
import { describe, expect, it } from 'vitest';
import { GET } from '@/app/api/internal/metrics/stale-pending-count/route';

interface CronResponseBody {
  ok: boolean;
  tenantCount: number;
  totalEmitted: number;
  staleHours: number;
  tenants: Array<{ tenantId: string; count: number }>;
}

function makeRequest(authHeader: string | null): Request {
  const headers = new Headers();
  if (authHeader !== null) {
    headers.set('Authorization', authHeader);
  }
  headers.set('x-request-id', `t139-${Math.random().toString(36).slice(2, 10)}`);
  return new Request(
    'http://localhost:3100/api/internal/metrics/stale-pending-count',
    { method: 'GET', headers },
  );
}

describe('T139 stale-pending-count cron handler — live Neon', () => {
  it('(a) rejects request without Bearer token when CRON_SECRET is set', async () => {
    if (!process.env.CRON_SECRET) {
      // Dev-mode lane allows unauthenticated calls — case (a) is vacuous.
      return;
    }
    const res = await GET(makeRequest(null) as never);
    expect(res.status).toBe(401);
  });

  it('(a) rejects request with wrong Bearer token', async () => {
    if (!process.env.CRON_SECRET) {
      return;
    }
    const res = await GET(makeRequest('Bearer not-the-real-secret') as never);
    expect(res.status).toBe(401);
  });

  it('(b)+(c)+(d) returns valid JSON shape with 24-hour staleHours', async () => {
    const auth = process.env.CRON_SECRET
      ? `Bearer ${process.env.CRON_SECRET}`
      : null;
    const res = await GET(makeRequest(auth) as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as CronResponseBody;
    expect(body.ok).toBe(true);
    expect(body.staleHours).toBe(24);
    expect(typeof body.tenantCount).toBe('number');
    expect(typeof body.totalEmitted).toBe('number');
    expect(Array.isArray(body.tenants)).toBe(true);

    // (d) shape of per-tenant entries
    for (const t of body.tenants) {
      expect(typeof t.tenantId).toBe('string');
      expect(t.tenantId.length).toBeGreaterThan(0);
      expect(typeof t.count).toBe('number');
      expect(t.count).toBeGreaterThan(0); // GROUP BY excludes zero-count tenants
    }

    // tenantCount and totalEmitted are consistent
    expect(body.tenantCount).toBe(body.tenants.length);
    const summed = body.tenants.reduce((acc, t) => acc + t.count, 0);
    expect(body.totalEmitted).toBe(summed);
  });
});
