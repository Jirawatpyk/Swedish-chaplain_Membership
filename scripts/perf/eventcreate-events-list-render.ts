/**
 * F6 Phase 10 T137 — events list render perf bench.
 *
 * Measures p50/p95/p99 latency of `listEvents` at design envelope:
 * 100 events × 500 attendees per plan.md Performance Goals.
 * Target: <500ms p95.
 *
 * Run:
 *   FEATURE_F6_EVENTCREATE=true pnpm tsx scripts/perf/eventcreate-events-list-render.ts
 */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { runListEvents } from '@/lib/events-admin-deps';
import { asTenantContext } from '@/modules/tenants';
import { eq } from 'drizzle-orm';

const EVENT_COUNT = Number(process.env.PERF_EVENT_COUNT ?? 100);
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 50);
const TENANT_SLUG = `perf-list-${Date.now()}`;
const STRICT = process.env.STRICT === '1';
const P95_TARGET_MS = 500;

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

async function main() {
  const ctx = asTenantContext(TENANT_SLUG);
  await runInTenant(ctx, async (tx) => {
    await tx.insert(tenantWebhookConfigs).values({
      tenantId: TENANT_SLUG,
      source: 'eventcreate',
      webhookSecretActive: 'test-secret-' + 'p'.repeat(43),
      enabled: true,
    });
    const rows = Array.from({ length: EVENT_COUNT }, (_, i) => ({
      tenantId: TENANT_SLUG,
      eventId: randomUUID(),
      source: 'eventcreate',
      externalId: `perf-ev-${i}-${Date.now()}`,
      name: `Perf Event ${i}`,
      startDate: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
      isPartnerBenefit: i % 3 === 0,
      isCulturalEvent: i % 5 === 0,
    }));
    await tx.insert(events).values(rows as unknown as Array<typeof events.$inferInsert>);
  });

  const latencies: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    const result = await runListEvents(TENANT_SLUG, {
      page: 1,
      pageSize: 25,
      includeArchived: false,
      partnerBenefitOnly: false,
      culturalEventOnly: false,
      categoryFilter: null,
    });
    latencies.push(performance.now() - start);
    if (!result.ok) {
      console.error('[perf] list call failed:', result.error.kind);
    }
  }

  // Cleanup
  try {
    await runInTenant(ctx, async (tx) => {
      await tx.delete(eventRegistrations).where(eq(eventRegistrations.tenantId, TENANT_SLUG));
      await tx.delete(events).where(eq(events.tenantId, TENANT_SLUG));
      await tx.delete(tenantWebhookConfigs).where(eq(tenantWebhookConfigs.tenantId, TENANT_SLUG));
    });
  } catch {}

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    bench: 'events-list-render',
    eventCount: EVENT_COUNT,
    iterations: ITERATIONS,
    p50Ms: Math.round(percentile(sorted, 0.5)),
    p95Ms: Math.round(percentile(sorted, 0.95)),
    p99Ms: Math.round(percentile(sorted, 0.99)),
    p95TargetMs: P95_TARGET_MS,
    p95UnderTarget: percentile(sorted, 0.95) < P95_TARGET_MS,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (STRICT && !report.p95UnderTarget) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
