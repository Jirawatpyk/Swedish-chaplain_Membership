/**
 * R6.B1 / Round 5 staff-review R001 + R021 closure — live-Neon
 * integration test for `/api/internal/observability/recompute-match-rate`.
 *
 * Prior to this test, the only coverage of the cron was a contract test
 * verifying bearer-auth gating + feature-flag short-circuit (`tests/
 * contract/cron/f6-recompute-match-rate.test.ts`). The SQL semantics
 * were never exercised, allowing the R001 bug to ship: the query
 * referenced a non-existent audit event type
 * (`match_resolution_completed`) and a non-existent payload field
 * (`payload.matchType`), so `eventcreate_match_rate_gauge` emitted
 * 0.0 forever — SC-002's 30-day post-flag-flip rollback signal was
 * unmeasurable.
 *
 * This test seeds 5 attendee match audits (3 matched + 2 unmatched/non-
 * member) under a freshly-created test tenant and asserts the cron-
 * emitted gauge value reflects the correct ratio (3/5 = 0.6). A future
 * regression to the SQL (renaming an event type, changing the
 * matched/total filter) is now caught at CI time.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { eventcreateMetrics } from '@/lib/metrics';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const CRON_SECRET = process.env.CRON_SECRET ?? 'test-cron-secret';

// vi.mock factory is hoisted before module-level `let` declarations;
// use vi.hoisted() to share a mutable holder safely across mock + tests.
const slugHolder = vi.hoisted(() => ({ current: 'pending' }));

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    // Override `env.tenant.slug` (read by `listKnownTenants()` in the
    // route) with the test tenant slug so the cron iterates ONLY our
    // isolated tenant, leaving production audit_log untouched.
    env: {
      ...actual.env,
      get tenant() {
        return { ...actual.env.tenant, slug: slugHolder.current };
      },
      features: { ...actual.env.features, f6EventCreate: true },
    },
  };
});

// Import the route AFTER vi.mock so the route picks up the mocked env.
const { POST } = await import('@/app/api/internal/observability/recompute-match-rate/route');

function buildCronRequest(): Request {
  return new Request(
    'http://localhost:3100/api/internal/observability/recompute-match-rate',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${CRON_SECRET}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
}

async function seedAuditRow(
  tenant: TestTenant,
  eventType: string,
  registrationId: string,
): Promise<void> {
  await runInTenant(tenant.ctx, async (tx) => {
    const requestId = `req-${registrationId.slice(0, 8)}`;
    await tx.execute(sql`
      INSERT INTO audit_log
        (event_type, tenant_id, actor_user_id, summary, request_id, payload, retention_years, timestamp)
      VALUES
        (
          ${eventType}::audit_event_type,
          ${tenant.ctx.slug}::text,
          '00000000-0000-0000-0000-000000000201',
          'R6.B1 seed',
          ${requestId}::text,
          jsonb_build_object(
            'severity', 'info',
            'registrationId', ${registrationId}::text
          ),
          5,
          NOW() - INTERVAL '1 day'
        )
    `);
  });
}

describe('R6.B1 — recompute-match-rate live-Neon integration', () => {
  let gaugeSpy: ReturnType<typeof vi.spyOn>;
  let capturedGaugeCalls: Array<{ tenantId: string; value: number }> = [];

  beforeAll(() => {
    gaugeSpy = vi
      .spyOn(eventcreateMetrics, 'matchRateGauge')
      .mockImplementation((tenantId, value) => {
        capturedGaugeCalls.push({ tenantId, value });
      });
  });

  afterAll(() => {
    gaugeSpy.mockRestore();
  });

  it('gauge ratio reflects matched / total over the 5 F6 attendee event types', async () => {
    const tenant = await createTestTenant('test');
    slugHolder.current = tenant.ctx.slug;
    try {
      // Seed 3 matched + 2 unmatched/non-member.
      await seedAuditRow(tenant, 'attendee_matched_member_contact', '11111111-2222-4333-8444-aaaaaaaaaaaa');
      await seedAuditRow(tenant, 'attendee_matched_member_domain', '11111111-2222-4333-8444-bbbbbbbbbbbb');
      await seedAuditRow(tenant, 'attendee_matched_member_fuzzy', '11111111-2222-4333-8444-cccccccccccc');
      await seedAuditRow(tenant, 'attendee_non_member', '11111111-2222-4333-8444-dddddddddddd');
      await seedAuditRow(tenant, 'attendee_unmatched', '11111111-2222-4333-8444-eeeeeeeeeeee');

      capturedGaugeCalls = [];
      const res = await POST(buildCronRequest() as never);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { ok: boolean; tenantsProcessed: number };
      expect(body.ok).toBe(true);
      expect(body.tenantsProcessed).toBeGreaterThanOrEqual(1);

      const ourCall = capturedGaugeCalls.find((c) => c.tenantId === tenant.ctx.slug);
      expect(ourCall).toBeDefined();
      // 3 matched / 5 total = 0.6
      expect(ourCall!.value).toBeCloseTo(0.6, 5);
    } finally {
      await tenant.cleanup();
    }
  });

  it('gauge value is 0 when all events are unmatched/non-member', async () => {
    const tenant = await createTestTenant('test');
    slugHolder.current = tenant.ctx.slug;
    try {
      await seedAuditRow(tenant, 'attendee_unmatched', '22222222-3333-4333-8555-aaaaaaaaaaaa');
      await seedAuditRow(tenant, 'attendee_non_member', '22222222-3333-4333-8555-bbbbbbbbbbbb');

      capturedGaugeCalls = [];
      await POST(buildCronRequest() as never);

      const ourCall = capturedGaugeCalls.find((c) => c.tenantId === tenant.ctx.slug);
      expect(ourCall).toBeDefined();
      // 0 matched / 2 total = 0
      expect(ourCall!.value).toBe(0);
    } finally {
      await tenant.cleanup();
    }
  });

  it('gauge value is 0 when no F6 attendee audits exist (denominator === 0 guard)', async () => {
    const tenant = await createTestTenant('test');
    slugHolder.current = tenant.ctx.slug;
    try {
      capturedGaugeCalls = [];
      await POST(buildCronRequest() as never);

      const ourCall = capturedGaugeCalls.find((c) => c.tenantId === tenant.ctx.slug);
      expect(ourCall).toBeDefined();
      // 0 / 0 → `total > 0 ? matched/total : 0` guard returns 0
      expect(ourCall!.value).toBe(0);
    } finally {
      await tenant.cleanup();
    }
  });
});
