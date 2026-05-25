/**
 * T029 (US1) — `activityFeedQuery` integration test (live Neon).
 *
 * Seeds audit rows across two tenants and asserts the live feed returns the
 * current tenant's events newest-first, never another tenant's (RLS), and that
 * members are forbidden.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import { activityFeedQuery, makeActivityFeedDeps } from '@/modules/insights';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';

describe('F9 activityFeedQuery — integration (T029)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;

  beforeAll(async () => {
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;

    // Seed 3 audit rows for A (oldest→newest) + 1 for B, via runInTenant so the
    // RLS WITH CHECK (tenant_id = current_setting) passes.
    // Future-dated so our 3 seeds sit at the top of the feed, above the shared
    // test DB's null-tenant_id legacy audit noise (the audit_log RLS policy
    // surfaces null-tenant rows to every tenant).
    await runInTenant(tenantA.ctx, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.insert(auditLog).values({
          tenantId: tenantA.ctx.slug,
          eventType: 'member_created',
          actorUserId: randomUUID(),
          summary: `A event ${i}`,
          requestId: `feed-A-${i}-${randomUUID()}`,
          timestamp: new Date(Date.UTC(2030, 0, 1, 0, i, 0)),
        });
      }
    });
    await runInTenant(tenantB.ctx, async (tx) => {
      await tx.insert(auditLog).values({
        tenantId: tenantB.ctx.slug,
        eventType: 'member_created',
        actorUserId: randomUUID(),
        summary: 'B event',
        requestId: `feed-B-${randomUUID()}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 5, 0)),
      });
    });
  }, 120_000);

  afterAll(async () => {
    // audit_log is append-only — cannot DELETE; test-tenant rows are disposable.
    await tenantA.cleanup().catch(() => {});
    await tenantB.cleanup().catch(() => {});
  });

  it('returns the tenant’s events newest-first and never another tenant’s (RLS)', async () => {
    // limit 100 so our seeds aren't pushed out by harness-emitted setup events
    // (user/tenant creation also writes audit rows with newer timestamps).
    const result = await activityFeedQuery(
      { limit: 100 },
      { actorUserId: randomUUID(), actorRole: 'admin', requestId: `q-${randomUUID()}` },
      tenantA.ctx,
      makeActivityFeedDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const summaries = result.value.map((e) => e.summary);
      // RLS isolation — tenant B's event must never appear in A's feed.
      expect(summaries).not.toContain('B event');
      // Our 3 seeds are the newest (future-dated) → top 3, newest-first.
      expect(summaries.slice(0, 3)).toEqual(['A event 2', 'A event 1', 'A event 0']);
      // AS-3 — each item carries actor + event type (not just a summary), so a
      // regression dropping the actor projection is caught.
      const top = result.value[0]!;
      expect(top.actorUserId).toBeTruthy();
      expect(top.eventType).toBe('member_created');
    }
  });

  it('respects the limit', async () => {
    const result = await activityFeedQuery(
      { limit: 2 },
      { actorUserId: randomUUID(), actorRole: 'manager', requestId: `q-${randomUUID()}` },
      tenantA.ctx,
      makeActivityFeedDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(2);
  });

  it('forbids members', async () => {
    const result = await activityFeedQuery(
      { limit: 10 },
      { actorUserId: randomUUID(), actorRole: 'member', requestId: `q-${randomUUID()}` },
      tenantA.ctx,
      makeActivityFeedDeps(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
  });
});
