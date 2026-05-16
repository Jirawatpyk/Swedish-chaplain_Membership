/**
 * F6 Phase 10 T136 — webhook ingest latency perf bench.
 *
 * Measures p50/p95/p99 latency of the `ingestWebhookAttendee` use-case
 * at the design envelope: 50k registrations/yr/tenant + 60 req/min
 * sustained per SC-003 / FR-005.
 *
 * Asserts <300ms p95 — failure path is informational (does not exit 1
 * unless STRICT=1 env var set; lets CI runs surface regressions
 * without breaking ship gates).
 *
 * Run locally against live Neon Singapore via:
 *   FEATURE_F6_EVENTCREATE=true pnpm tsx scripts/perf/eventcreate-webhook-ingest-latency.ts
 *
 * Output JSON to stdout — operator captures in retrospective.md.
 */
import { performance } from 'node:perf_hooks';
import { randomUUID, createHmac } from 'node:crypto';
import { runInTenant } from '@/lib/db';
import {
  events,
  tenantWebhookConfigs,
  eventRegistrations,
} from '@/modules/events/infrastructure/schema';
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { asTenantContext } from '@/modules/tenants';
import { eq } from 'drizzle-orm';

const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 200);
const TENANT_SLUG = `perf-webhook-${Date.now()}`;
const WEBHOOK_SECRET = 'p'.repeat(43);
const STRICT = process.env.STRICT === '1';
const P95_TARGET_MS = 300;

interface Sample {
  readonly latencyMs: number;
}

function makeSignedPayload(eventExternalId: string, requestId: string) {
  const payload = JSON.stringify({
    event: {
      externalId: eventExternalId,
      name: 'Perf Event',
      startDate: '2026-06-01T18:00:00+07:00',
    },
    attendee: {
      externalId: `att-${requestId}`,
      email: `perf-${requestId}@example.com`,
      companyName: 'Perf Co',
      fullName: 'Perf Tester',
    },
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return { payload, signature };
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

async function main() {
  // Seed tenant + webhook config + event
  const ctx = asTenantContext(TENANT_SLUG);
  const eventExternalId = `perf-event-${Date.now()}`;
  try {
    await runInTenant(ctx, async (tx) => {
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: TENANT_SLUG,
        source: 'eventcreate',
        webhookSecretActive: `whsec_${WEBHOOK_SECRET}`,
        enabled: true,
      });
      await tx.insert(events).values({
        tenantId: TENANT_SLUG,
        eventId: randomUUID(),
        source: 'eventcreate',
        externalId: eventExternalId,
        name: 'Perf Event',
        startDate: new Date('2026-06-01T18:00:00+07:00'),
        isPartnerBenefit: false,
        isCulturalEvent: false,
      } as unknown as typeof events.$inferInsert);
    });
  } catch (err) {
    console.error('[perf] tenant seed failed:', err instanceof Error ? err.message : err);
    if (STRICT) process.exit(1);
    return;
  }

  const samples: Sample[] = [];
  const deps = makeIngestWebhookAttendeeDeps();
  let errorCount = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const requestId = `${randomUUID()}`;
    const start = performance.now();
    try {
      const result = await ingestWebhookAttendee(
        {
          tenantId: TENANT_SLUG,
          requestId,
          source: 'eventcreate_webhook',
          rawPayload: JSON.parse(makeSignedPayload(eventExternalId, requestId).payload),
          sourceIp: '127.0.0.1',
        },
        deps,
      );
      const latencyMs = performance.now() - start;
      if (!result.ok) errorCount++;
      samples.push({ latencyMs });
    } catch {
      errorCount++;
      samples.push({ latencyMs: performance.now() - start });
    }
  }

  // Cleanup
  try {
    await runInTenant(ctx, async (tx) => {
      await tx
        .delete(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, TENANT_SLUG));
      await tx.delete(events).where(eq(events.tenantId, TENANT_SLUG));
      await tx
        .delete(tenantWebhookConfigs)
        .where(eq(tenantWebhookConfigs.tenantId, TENANT_SLUG));
    });
  } catch {}

  const sortedLat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(sortedLat, 0.5);
  const p95 = percentile(sortedLat, 0.95);
  const p99 = percentile(sortedLat, 0.99);

  const report = {
    bench: 'webhook-ingest-latency',
    iterations: ITERATIONS,
    errorCount,
    p50Ms: Math.round(p50),
    p95Ms: Math.round(p95),
    p99Ms: Math.round(p99),
    p95TargetMs: P95_TARGET_MS,
    p95UnderTarget: p95 < P95_TARGET_MS,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(report, null, 2));
  if (STRICT && !report.p95UnderTarget) process.exit(1);
}

main().catch((e) => {
  console.error('[perf] bench failed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
