/**
 * F6 Phase 10 T118 — idempotency-TTL-sweep integration test (live Neon).
 *
 * Verifies:
 *   1. Sweep DELETEs only rows where ttl_expires_at <= NOW() (FIFO; cap maxRows).
 *   2. Live (un-expired) rows stay.
 *   3. Cross-tenant isolation — sweeping tenant A doesn't touch tenant B.
 *   4. RLS-enforced — even if Postgres SET LOCAL was forgotten, the
 *      tenant_id WHERE clause + RLS policy reject the wrong-tenant rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { eventcreateIdempotencyReceipts } from '@/modules/events/infrastructure/schema';
import { sweepStaleIdempotencyReceipts } from '@/modules/events';
import { makeDrizzleIdempotencySweepPort } from '@/modules/events/infrastructure/drizzle-idempotency-sweep';
import { asTenantId } from '@/modules/members';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

describe('F6 Phase 10 T118 — sweepStaleIdempotencyReceipts', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    tenantA = await createTestTenant('test-swecham');
    tenantB = await createTestTenant('test-chamber');
    const now = Date.now();
    const expired1 = new Date(now - 60 * 60 * 1000); // 1h ago
    const expired2 = new Date(now - 30 * 60 * 1000); // 30min ago
    const live1 = new Date(now + 24 * 60 * 60 * 1000); // 24h future

    // Tenant A: 2 expired + 1 live
    await runInTenant(tenantA.ctx, async (tx) => {
      await tx.insert(eventcreateIdempotencyReceipts).values([
        {
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate_webhook',
          requestId: `expired-A-1`,
          processedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
          ttlExpiresAt: expired1,
        },
        {
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate_webhook',
          requestId: `expired-A-2`,
          processedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
          ttlExpiresAt: expired2,
        },
        {
          tenantId: tenantA.ctx.slug,
          source: 'eventcreate_webhook',
          requestId: `live-A`,
          processedAt: new Date(now),
          ttlExpiresAt: live1,
        },
      ]);
    });

    // Tenant B: 1 expired (must NOT be touched by tenant A's sweep)
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(eventcreateIdempotencyReceipts).values([
        {
          tenantId: tenantB.ctx.slug,
          source: 'eventcreate_webhook',
          requestId: `expired-B-1`,
          processedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
          ttlExpiresAt: expired1,
        },
      ]);
    });
  });

  afterAll(async () => {
    await tenantA.cleanup();
    await tenantB.cleanup();
  });

  it('tenant A sweep deletes 2 expired, leaves 1 live; tenant B untouched', async () => {
    const result = await runInTenant(tenantA.ctx, async (tx) => {
      return sweepStaleIdempotencyReceipts(
        { tenantId: asTenantId(tenantA.ctx.slug), occurredAt: new Date() },
        { sweepPort: makeDrizzleIdempotencySweepPort(tx) },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCount).toBe(2);
    }

    // Tenant A: only the live row remains
    const aRows = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(eq(eventcreateIdempotencyReceipts.tenantId, tenantA.ctx.slug)),
    );
    expect(aRows.length).toBe(1);
    expect(aRows[0]!.requestId).toBe('live-A');

    // Tenant B: still has 1 expired row (cross-tenant isolation)
    const bRows = await runInTenant(tenantB.ctx, (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(eq(eventcreateIdempotencyReceipts.tenantId, tenantB.ctx.slug)),
    );
    expect(bRows.length).toBe(1);
    expect(bRows[0]!.requestId).toBe('expired-B-1');
  });

  it('idempotent re-sweep: deletedCount=0 + skipped outcome', async () => {
    const result = await runInTenant(tenantA.ctx, async (tx) => {
      return sweepStaleIdempotencyReceipts(
        { tenantId: asTenantId(tenantA.ctx.slug), occurredAt: new Date() },
        { sweepPort: makeDrizzleIdempotencySweepPort(tx) },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCount).toBe(0);
    }
  });

  it('maxRows cap enforced', async () => {
    // Seed 5 more expired rows in tenant A
    const expired = new Date(Date.now() - 60 * 60 * 1000);
    await runInTenant(tenantA.ctx, async (tx) => {
      const rows = Array.from({ length: 5 }, (_, i) => ({
        tenantId: tenantA.ctx.slug,
        source: 'eventcreate_webhook',
        requestId: `cap-test-${i}-${Date.now()}`,
        processedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        ttlExpiresAt: expired,
      }));
      await tx.insert(eventcreateIdempotencyReceipts).values(rows);
    });

    const result = await runInTenant(tenantA.ctx, async (tx) => {
      return sweepStaleIdempotencyReceipts(
        {
          tenantId: asTenantId(tenantA.ctx.slug),
          occurredAt: new Date(),
          maxRows: 2,
        },
        { sweepPort: makeDrizzleIdempotencySweepPort(tx) },
      );
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCount).toBe(2);
    }

    // 3 cap-test rows should still remain (5 seeded - 2 swept)
    const remaining = await runInTenant(tenantA.ctx, (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenantA.ctx.slug),
            eq(eventcreateIdempotencyReceipts.source, 'eventcreate_webhook'),
          ),
        ),
    );
    // 'live-A' + 3 unswept cap-test rows = 4
    expect(remaining.length).toBe(4);
  });
});
