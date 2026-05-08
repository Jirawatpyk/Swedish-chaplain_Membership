/**
 * F8 Phase 5 wave K24 · T115a — Daily lapse-cycles-on-grace-expiry
 * coordinator.
 *
 * Triggered DAILY at 06:30 Asia/Bangkok by cron-job.org. Walks every
 * active tenant's cycles in `awaiting_payment` whose
 * `expires_at + grace_period_days < now` and transitions them to
 * `lapsed` with the **specific** `closed_reason` discriminator
 * (`grace_expired` vs `payment_failed`) per FR-004 + AS3.
 *
 * Sequenced 30 min BEFORE `reconcile-pending-reactivations-coordinator`
 * (07:00) so that any cycle that JUST crossed the grace boundary
 * doesn't get a reminder email out of the dispatcher (which runs
 * earlier at 06:00) immediately followed by a lapse-transition —
 * the lapse-transition tx wins the day's race because the dispatcher
 * has already finished its pass for the day.
 *
 * Architecture mirrors `reconcile-pending-reactivations-coordinator`
 * (T139) — fans out via internal HTTP to per-tenant routes for
 * own-budget isolation.
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check).
 *
 * Kill-switch: `FEATURE_F8_RENEWALS=false` returns 200 + skipped.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerTenantResult {
  readonly tenant_id: string;
  readonly skipped?: boolean;
  readonly cycles_processed?: number;
  readonly grace_expired?: number;
  readonly payment_failed?: number;
  readonly transition_race_skipped?: number;
  readonly errors?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const startedAt = Date.now();

  // Resolve active tenants (MVP single-tenant = [env.tenant.slug]).
  const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
  if (activeTenants.length === 0) {
    return NextResponse.json({
      tenants_enqueued: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      duration_ms: Date.now() - startedAt,
      per_tenant_results: [],
    });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async (): Promise<PerTenantResult> => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/lapse-cycles-on-grace-expiry/${encodeURIComponent(tenantId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              'x-request-id': correlationId,
            },
          },
        );
        let json: Record<string, unknown> = {};
        try {
          json = (await r.json()) as Record<string, unknown>;
        } catch {
          return {
            tenant_id: tenantId,
            error: `http_${r.status}_json_parse_failed`,
          };
        }
        if (!r.ok) {
          return { tenant_id: tenantId, error: `http_${r.status}` };
        }
        return {
          tenant_id: tenantId,
          skipped: Boolean(json.skipped),
          cycles_processed:
            typeof json.cycles_processed === 'number'
              ? json.cycles_processed
              : 0,
          grace_expired:
            typeof json.grace_expired === 'number' ? json.grace_expired : 0,
          payment_failed:
            typeof json.payment_failed === 'number' ? json.payment_failed : 0,
          transition_race_skipped:
            typeof json.transition_race_skipped === 'number'
              ? json.transition_race_skipped
              : 0,
          errors: typeof json.errors === 'number' ? json.errors : 0,
          duration_ms:
            typeof json.duration_ms === 'number' ? json.duration_ms : 0,
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'rejected') {
      return { tenant_id: tenantId, error: String(r.reason).slice(0, 400) };
    }
    return r.value;
  });

  const tenantsSucceeded = perTenantResults.filter(
    (r) => r.error === undefined,
  ).length;
  const tenantsFailed = perTenantResults.length - tenantsSucceeded;

  logger.info(
    {
      correlationId,
      tenants_enqueued: activeTenants.length,
      tenants_succeeded: tenantsSucceeded,
      tenants_failed: tenantsFailed,
      duration_ms: Date.now() - startedAt,
    },
    'cron.renewals.lapse-cycles.coordinator.complete',
  );

  return NextResponse.json({
    tenants_enqueued: activeTenants.length,
    tenants_succeeded: tenantsSucceeded,
    tenants_failed: tenantsFailed,
    duration_ms: Date.now() - startedAt,
    per_tenant_results: perTenantResults,
  });
}
