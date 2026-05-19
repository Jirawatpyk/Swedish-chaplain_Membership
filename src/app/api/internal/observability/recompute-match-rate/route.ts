/**
 * POST `/api/internal/observability/recompute-match-rate`
 *
 * Phase 10 T126 — hourly cron handler that refreshes the per-tenant
 * `eventcreate_match_rate_gauge` from a rolling 30-day window of
 * F6 match-resolution audit events.
 *
 * R6.B1 / Round 5 staff-review R001 closure — the prior implementation
 * queried event_type `match_resolution_completed` which does NOT exist
 * in the F6 audit taxonomy (`audit-port.ts:87-91` canonical list). It
 * also read a non-existent `payload->>'matchType'` field — the match
 * type is encoded in the `event_type` column itself, not the payload.
 * The gauge therefore emitted 0.0 forever, silently masking SC-002
 * (the 30-day post-flag-flip rollback signal). Fixed here by querying
 * the 5 actual emitted event types directly.
 *
 * Formula:
 *   matched = COUNT(*) WHERE event_type IN
 *     ('attendee_matched_member_contact',
 *      'attendee_matched_member_domain',
 *      'attendee_matched_member_fuzzy')
 *   total = COUNT(*) WHERE event_type IN (those 3 + 'attendee_non_member' + 'attendee_unmatched')
 *   matchRate = total > 0 ? matched / total : 0
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
// /review Full Scope 2026-05-19 — explicit `force-dynamic` to match
// project-wide cron-route convention (precedent: PR #22 +
// 2026-05-19 F1/F4 fix batch). Route uses `verifyCronBearer`, per-tenant
// `runInTenant(slug, ...)` Drizzle counts under RLS, and per-tick gauge
// emission — Node-runtime + dynamic-execution dependent.
export const dynamic = 'force-dynamic';
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
        // R6.B1 — query the 5 actual F6 match-resolution audit event
        // types. The `event_type` column carries the discriminator;
        // there is no payload.matchType field. Emitted from
        // `process-attendee-in-tx.ts:267-433` (5 emit sites, one per
        // match variant).
        const row = await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE event_type IN (
                'attendee_matched_member_contact',
                'attendee_matched_member_domain',
                'attendee_matched_member_fuzzy'
              )
            )::numeric AS matched,
            COUNT(*) FILTER (
              WHERE event_type IN (
                'attendee_matched_member_contact',
                'attendee_matched_member_domain',
                'attendee_matched_member_fuzzy',
                'attendee_non_member',
                'attendee_unmatched'
              )
            )::numeric AS total
          FROM audit_log
          WHERE event_type IN (
              'attendee_matched_member_contact',
              'attendee_matched_member_domain',
              'attendee_matched_member_fuzzy',
              'attendee_non_member',
              'attendee_unmatched'
            )
            AND timestamp > NOW() - INTERVAL '30 days'
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
