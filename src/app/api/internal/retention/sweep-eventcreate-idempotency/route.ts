/**
 * POST `/api/internal/retention/sweep-eventcreate-idempotency`
 *
 * Phase 10 T116 — daily F6 idempotency-receipt TTL sweep cron handler.
 * Scans all known tenants; per tenant runs `sweepStaleIdempotencyReceipts`
 * use-case under `runInTenant` to DELETE rows from
 * `eventcreate_idempotency_receipts` where `ttl_expires_at <= NOW()`
 * (cap at maxRows per tenant).
 *
 * Schedule: daily 04:00 Asia/Bangkok via cron-job.org.
 *
 * Authz: Bearer auth via `CRON_SECRET`.
 *
 * Failure mode: per-tenant failures logged but do not block other
 * tenants. Returns 200 with per-tenant outcome list.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import { eventcreateMetrics } from '@/lib/metrics';
import { gateF6Cron } from '@/lib/events-cron-deps';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import {
  sweepStaleIdempotencyReceipts,
  makeDrizzleIdempotencySweepPort,
} from '@/modules/events';

export const runtime = 'nodejs';
export const maxDuration = 120;

const ROUTE = '/api/internal/retention/sweep-eventcreate-idempotency';

async function listKnownTenants(): Promise<ReadonlyArray<string>> {
  return [env.tenant.slug];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Security review 2026-05-17 closure: use shared gateCronBearerOrRespond
  // for audit + IP rate-limit consistency with sweep-error-csv-blobs.
  const gate = await gateF6Cron(request, ROUTE);
  if (gate) return gate;

  if (!env.features.f6EventCreate) {
    return NextResponse.json({ ok: true, skipped: 'feature_off' }, { status: 200 });
  }

  const occurredAt = new Date();
  const tenants = await listKnownTenants();
  const perTenant: Array<{
    tenantId: string;
    outcome: 'success' | 'error';
    deletedCount?: number;
    durationMs?: number;
    message?: string;
  }> = [];

  for (const tenantSlug of tenants) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const tenantId = asTenantId(tenantSlug);
      const result = await runInTenant(ctx, async (tx) => {
        return sweepStaleIdempotencyReceipts(
          { tenantId, occurredAt },
          { sweepPort: makeDrizzleIdempotencySweepPort(tx) },
        );
      });
      if (result.ok) {
        eventcreateMetrics.idempotencySweepRowsTotal(
          tenantSlug,
          result.value.deletedCount > 0 ? 'swept' : 'skipped',
        );
        // Per-row counter increments for granular dashboards
        for (let i = 1; i < result.value.deletedCount; i++) {
          eventcreateMetrics.idempotencySweepRowsTotal(tenantSlug, 'swept');
        }
        logger.info(
          {
            event: 'eventcreate_idempotency_sweep_completed',
            tenantSlug,
            deletedCount: result.value.deletedCount,
            durationMs: result.value.durationMs,
          },
          '[F6] idempotency sweep completed',
        );
        perTenant.push({
          tenantId: tenantSlug,
          outcome: 'success',
          deletedCount: result.value.deletedCount,
          durationMs: result.value.durationMs,
        });
      } else {
        // AA1 alert path — emit stderr pino so cron-job.org failure
        // reconciliation can detect the stall.
        logger.error(
          {
            event: 'eventcreate_idempotency_sweep_failed',
            tenantSlug,
            err: result.error.message,
          },
          '[F6] idempotency sweep failed',
        );
        perTenant.push({
          tenantId: tenantSlug,
          outcome: 'error',
          message: result.error.message,
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { event: 'eventcreate_idempotency_sweep_throw', tenantSlug, err: message },
        '[F6] idempotency sweep: per-tenant tx threw',
      );
      perTenant.push({ tenantId: tenantSlug, outcome: 'error', message });
    }
  }

  return NextResponse.json({ ok: true, perTenant }, { status: 200 });
}
