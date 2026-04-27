/**
 * T139 — Stale-pending-count cron handler integration test.
 *
 * Spec authority: `specs/009-online-payment/plan.md` § VII.Metrics +
 * `docs/runbooks/stale-pending-count.md`.
 *
 * Asserts:
 *   (a) Bearer auth — handler rejects missing/wrong CRON_SECRET with 401
 *   (b) Live DB query — seeded pending Payment > 24h surfaces in response
 *   (c) Tenant grouping — each tenant gets its own row in the response
 *   (d) Threshold respected — pending Payment < 24h does NOT count
 *
 * Mocking policy: NONE for the DB path (live Neon). The OTel gauge
 * emission is a fire-and-forget side effect — verified via the
 * response payload (which mirrors the gauge values).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { payments, type NewPaymentRow } from '@/modules/payments/infrastructure/schema';
import { GET } from '@/app/api/internal/metrics/stale-pending-count/route';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

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
  headers.set('x-request-id', `t139-${randomUUID().slice(0, 8)}`);
  return new Request(
    'http://localhost:3100/api/internal/metrics/stale-pending-count',
    { method: 'GET', headers },
  );
}

describe('T139 stale-pending-count cron handler — live Neon', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  const seededPaymentIds: string[] = [];

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed:
    //   tenantA: 2 pending rows > 24h (should surface, count=2)
    //   tenantA: 1 pending row < 24h (should NOT surface — fresh)
    //   tenantA: 1 succeeded row > 24h (should NOT surface — terminal)
    //   tenantB: 1 pending row > 24h (should surface, count=1)
    const now = new Date();
    const oldInitiatedAt = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago
    const freshInitiatedAt = new Date(now.getTime() - 1 * 60 * 60 * 1000); // 1h ago

    const seedRow = (
      tenant: TestTenant,
      status: 'pending' | 'succeeded',
      initiatedAt: Date,
    ): NewPaymentRow => ({
      id: randomUUID(),
      tenantId: tenant.ctx.slug,
      invoiceId: randomUUID(),
      memberId: randomUUID(),
      method: 'card',
      status,
      amountSatang: 100000n,
      currency: 'THB',
      processorPaymentIntentId: `pi_t139_${randomUUID().slice(0, 8)}`,
      processorEnvironment: 'test',
      attemptSeq: 1,
      initiatedAt,
      actorUserId: randomUUID(),
      correlationId: `corr-t139-${randomUUID().slice(0, 8)}`,
    });

    const aOld1 = seedRow(tenantA, 'pending', oldInitiatedAt);
    const aOld2 = seedRow(tenantA, 'pending', oldInitiatedAt);
    const aFresh = seedRow(tenantA, 'pending', freshInitiatedAt);
    const aSucceeded = seedRow(tenantA, 'succeeded', oldInitiatedAt);
    const bOld = seedRow(tenantB, 'pending', oldInitiatedAt);

    seededPaymentIds.push(
      aOld1.id as string,
      aOld2.id as string,
      aFresh.id as string,
      aSucceeded.id as string,
      bOld.id as string,
    );

    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(payments).values([aOld1, aOld2, aFresh, aSucceeded]);
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(payments).values(bOld);
    });
  });

  afterAll(async () => {
    if (seededPaymentIds.length === 0) return;
    // Cleanup outside of RLS — payment table has RLS+FORCE so direct
    // delete is a no-op under chamber_app role. Use neondb_owner.
    const { sql } = await import('drizzle-orm');
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      await tx.delete(payments).where(inArray(payments.id, seededPaymentIds));
    });
  });

  it('(a) rejects request without Bearer token', async () => {
    // Skip if no CRON_SECRET configured (dev-mode allows unauthenticated).
    if (!process.env.CRON_SECRET) {
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

  it('(b)+(c)+(d) returns per-tenant stale-pending counts; ignores fresh + terminal rows', async () => {
    const auth = process.env.CRON_SECRET
      ? `Bearer ${process.env.CRON_SECRET}`
      : null;
    const res = await GET(makeRequest(auth) as never);
    expect(res.status).toBe(200);

    const body = (await res.json()) as CronResponseBody;
    expect(body.ok).toBe(true);
    expect(body.staleHours).toBe(24);

    // Find our seeded tenants in the response. Other tenants in the
    // shared dev DB may also have stale-pending rows; we assert ON OUR
    // TENANTS only (substring on slug because TestTenant uses unique
    // slugs that don't collide).
    const tenantAResp = body.tenants.find((t) => t.tenantId === tenantA.ctx.slug);
    const tenantBResp = body.tenants.find((t) => t.tenantId === tenantB.ctx.slug);

    expect(tenantAResp, 'tenantA must surface its 2 pending > 24h rows').toBeDefined();
    expect(tenantAResp?.count).toBe(2);

    expect(tenantBResp, 'tenantB must surface its 1 pending > 24h row').toBeDefined();
    expect(tenantBResp?.count).toBe(1);
  });

  it('(d) fresh pending row (< 24h) is NOT surfaced', async () => {
    // Already covered by case (b)+(c)+(d) — tenantA shows count=2,
    // not 3, despite having 3 total pending rows. This case is an
    // explicit assertion for documentation.
    const auth = process.env.CRON_SECRET
      ? `Bearer ${process.env.CRON_SECRET}`
      : null;
    const res = await GET(makeRequest(auth) as never);
    const body = (await res.json()) as CronResponseBody;
    const tenantAResp = body.tenants.find((t) => t.tenantId === tenantA.ctx.slug);
    expect(tenantAResp?.count).toBe(2);
    expect(tenantAResp?.count).not.toBe(3);
  });
});
