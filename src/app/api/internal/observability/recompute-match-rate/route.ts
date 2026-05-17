/**
 * POST `/api/internal/observability/recompute-match-rate`
 *
 * Phase 10 T126 — hourly cron handler that refreshes the per-tenant
 * `eventcreate_match_rate_gauge` from a rolling 30-day window of
 * `match_resolution_completed` audit events.
 *
 * Formula:
 *   matchRate = (member_contact + member_domain + member_fuzzy) /
 *               total_resolved
 *
 * Refreshes once per hour from cron-job.org per `docs/runbooks/cron-jobs.md`.
 *
 * Authz: Bearer auth via `CRON_SECRET`.
 * Tenant scope: enumerates known tenants from F1 `tenants` table; per-tenant
 * `runInTenant(slug, ...)` so each query honors RLS.
 *
 * SLO budget: gauge value should reach ≥ 0.70 after 30 days post-flag-flip
 * for a tenant with sustained F3 onboarding (SC-002).
 *
 * Failure handling: per-tenant failures logged but do not block other
 * tenants. Returns 200 with `{ok: true, tenantsProcessed, errors}` so
 * the cron coordinator sees per-tenant outcomes.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import { eventcreateMetrics } from '@/lib/metrics';
import { gateF6Cron } from '@/lib/events-cron-deps';
import { asTenantContext } from '@/modules/tenants';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ROUTE = '/api/internal/observability/recompute-match-rate';

interface RecomputeResult {
  readonly tenantsProcessed: number;
  readonly errors: ReadonlyArray<{ readonly tenantId: string; readonly message: string }>;
}

async function listKnownTenants(): Promise<ReadonlyArray<string>> {
  // MVP guard: enumerate from env. Post-SaaS multi-tenant onboarding
  // (F2 → F3 tenant table) this becomes a tenants-table SELECT.
  return [env.tenant.slug];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Security review 2026-05-17 closure: use shared gateCronBearerOrRespond
  // for audit + IP rate-limit consistency.
  const gate = await gateF6Cron(request, ROUTE);
  if (gate) return gate;

  if (!env.features.f6EventCreate) {
    // Flag off — nothing to recompute; return 200 so cron-job.org doesn't retry.
    return NextResponse.json({ ok: true, skipped: 'feature_off' }, { status: 200 });
  }

  const tenants = await listKnownTenants();
  const errors: Array<{ tenantId: string; message: string }> = [];
  let processed = 0;

  for (const tenantId of tenants) {
    try {
      const ctx = asTenantContext(tenantId);
      const value = await runInTenant(ctx, async (tx) => {
        const row = await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE payload->>'matchType' IN ('member_contact','member_domain','member_fuzzy')
            )::numeric AS matched,
            COUNT(*) FILTER (
              WHERE payload->>'matchType' IS NOT NULL
            )::numeric AS total
          FROM audit_log
          WHERE event_type = 'match_resolution_completed'
            AND emitted_at > NOW() - INTERVAL '30 days'
            AND tenant_id = ${tenantId}
        `);
        const rows = row as unknown as ReadonlyArray<{
          matched: string | number;
          total: string | number;
        }>;
        const first = rows[0];
        if (!first) return 0;
        const total = Number(first.total ?? 0);
        const matched = Number(first.matched ?? 0);
        return total > 0 ? matched / total : 0;
      });
      eventcreateMetrics.matchRateGauge(tenantId, value);
      processed += 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { event: 'recompute_match_rate_per_tenant_failed', tenantId, err: message },
        '[F6] recompute-match-rate: per-tenant failure',
      );
      errors.push({ tenantId, message });
    }
  }

  const result: RecomputeResult = { tenantsProcessed: processed, errors };
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
}
