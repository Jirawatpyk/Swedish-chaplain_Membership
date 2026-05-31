/**
 * Audit-viewer perf gate (T098 → F9 US2 / FR-008).
 *
 * Seeds 50,000 audit rows for one tenant and measures the `auditQuery` first-page
 * latency (keyset `ORDER BY timestamp DESC, id DESC LIMIT 50`). FR-008 sets the
 * budget at **p95 < 1 s for a tenant with ≥ 50,000 audit events**.
 *
 * Backed by the migration-0190 composites:
 *   - `audit_log_tenant_ts_idx        (tenant_id, timestamp DESC)`        — no-filter page
 *   - `audit_log_tenant_event_ts_idx  (tenant_id, event_type, ts DESC)`   — event-type filter
 *   - `audit_log_tenant_actor_ts_idx  (tenant_id, actor_user_id, ts DESC)`— actor filter
 *
 * The default target IS the FR-008 CP (1000 ms) — unlike the tight timeline gate
 * (500 ms), the audit budget is generous enough that even local Bangkok→Neon-SG
 * (~25 ms RTT × the query + actor-directory enrichment) lands well inside it.
 * EXPLAIN (ANALYZE) at 50k shows the DB layer at ~20–28 ms (server-side,
 * network-independent: first-page Bitmap Index Scan, no Seq Scan). Override the
 * wall-clock target for a strict in-region staging run via `PERF_AUDIT_P95_MS`.
 *
 * Gated by RUN_PERF=1 so the 50k seed doesn't run on every CI tick. The numeric
 * wall-clock CP (FR-008) is confirmed on staging in-region before flag-flip.
 *
 * Run locally:
 *   RUN_PERF=1 pnpm test:integration tests/integration/insights/audit-perf.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { auditQuery, makeAuditQueryDeps } from '@/modules/insights';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const RUN_PERF = process.env.RUN_PERF === '1';
const SEED_EVENTS = 50_000;
const CHUNK = 1000;
const PAGE_SIZE = 50;
const RUN_COUNT = 20;
// Default IS the FR-008 CP (1 s). The audit query is far lighter than the
// timeline UNION, so the 1 s budget absorbs the ~25 ms Bangkok→SG RTT locally.
// Override for an explicit in-region (sin1 ↔ ap-southeast-1) staging assertion.
const P95_TARGET_MS = Number(process.env.PERF_AUDIT_P95_MS ?? '1000');

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

const meta = () => ({
  actorUserId: randomUUID(),
  actorRole: 'admin' as const,
  requestId: `audit-perf-${randomUUID()}`,
});

describe.skipIf(!RUN_PERF)('audit perf @ 50k events (T098, RUN_PERF=1)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    // Bulk-insert via the BYPASSRLS owner `db` (seed setup is allowed to skip
    // tenant scoping); rows carry the tenant slug so the runtime auditQuery
    // (which DOES run the explicit `tenant_id = ctx.slug` predicate) sees them.
    for (let i = 0; i < SEED_EVENTS; i += CHUNK) {
      const batch = Array.from({ length: Math.min(CHUNK, SEED_EVENTS - i) }).map(
        (_, j) => ({
          // ~1/3 member_updated, ~2/3 member_created — exercises the event-type
          // filter's selectivity against the composite index.
          eventType: ((i + j) % 3 === 0 ? 'member_updated' : 'member_created') as
            | 'member_updated'
            | 'member_created',
          actorUserId: 'perf-seeder',
          summary: `synthetic audit ${i + j}`,
          requestId: `audit-perf-${i + j}`,
          tenantId: tenant.ctx.slug,
          payload: { member_id: `m-${(i + j) % 5000}`, seq: i + j },
          // Staggered timestamps so ORDER BY + keyset pagination are meaningful.
          timestamp: new Date(Date.now() - (i + j) * 1000),
        }),
      );
      await db.insert(auditLog).values(batch);
    }
  }, 180_000);

  afterAll(async () => {
    // Explicitly drop the 50k seed (don't leave them orphaned on shared Neon).
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenant.ctx.slug)).catch(() => {});
    await tenant.cleanup().catch(() => {});
  }, 120_000);

  it(`first page p95 < ${P95_TARGET_MS}ms (${PAGE_SIZE} of ${SEED_EVENTS} events)`, async () => {
    const deps = makeAuditQueryDeps();
    // Warm-up — let the planner cache the query + index pages.
    await auditQuery({ limit: PAGE_SIZE }, meta(), tenant.ctx, deps);

    const samples: number[] = [];
    for (let i = 0; i < RUN_COUNT; i++) {
      const t0 = performance.now();
      const r = await auditQuery({ limit: PAGE_SIZE }, meta(), tenant.ctx, deps);
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.rows.length).toBe(PAGE_SIZE);
      samples.push(t1 - t0);
    }

    const p95 = percentile(samples, 95);
    const p50 = percentile(samples, 50);
    console.log(
      `  audit perf @ ${SEED_EVENTS} events: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (target ${P95_TARGET_MS}ms)`,
    );
    expect(p95).toBeLessThan(P95_TARGET_MS);
  }, 60_000);

  it(`event-type-filtered page p95 < ${P95_TARGET_MS}ms (composite index)`, async () => {
    const deps = makeAuditQueryDeps();
    await auditQuery({ eventType: ['member_updated'], limit: PAGE_SIZE }, meta(), tenant.ctx, deps);

    const samples: number[] = [];
    for (let i = 0; i < RUN_COUNT; i++) {
      const t0 = performance.now();
      const r = await auditQuery(
        { eventType: ['member_updated'], limit: PAGE_SIZE },
        meta(),
        tenant.ctx,
        deps,
      );
      const t1 = performance.now();
      expect(r.ok).toBe(true);
      samples.push(t1 - t0);
    }

    const p95 = percentile(samples, 95);
    console.log(
      `  audit perf (event-type filter) @ ${SEED_EVENTS}: p95=${p95.toFixed(0)}ms (target ${P95_TARGET_MS}ms)`,
    );
    expect(p95).toBeLessThan(P95_TARGET_MS);
  }, 60_000);
});
