/**
 * POST `/api/internal/retention/pseudonymise-eventcreate`
 *
 * Phase 10 T114 — daily F6 retention sweep cron handler. Scans all
 * known tenants; per tenant runs `pseudonymiseStaleNonMemberPii` use-
 * case under `runInTenant` to:
 *   - List non-member + unmatched registrations older than 2y where
 *     `pii_pseudonymised_at IS NULL`
 *   - Replace email + name + company with deterministic salted SHA-256
 *   - Emit per-row `pii_pseudonymised` + aggregate
 *     `pii_pseudonymisation_sweep_run` audit
 *   - Increment `eventcreate_pii_pseudonymisation_sweep_rows_total`
 *
 * Schedule: daily 03:00 Asia/Bangkok via cron-job.org (per
 * `docs/runbooks/cron-jobs.md`).
 *
 * Authz: Bearer auth via `CRON_SECRET`.
 *
 * Failure mode: per-tenant failures logged but do not block other
 * tenants. Returns 200 with per-tenant outcome list so the cron
 * dashboard surfaces failures.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { createHmac, createHash } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import { eventcreateMetrics } from '@/lib/metrics';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { asTenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import {
  pseudonymiseStaleNonMemberPii,
  makePseudonymiseStaleNonMemberPiiDeps,
} from '@/modules/events';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ROUTE = '/api/internal/retention/pseudonymise-eventcreate';

function makeHasher(salt: string): { hash(input: string): string } {
  return {
    hash(input: string): string {
      // HMAC-SHA-256 with the salt (deterministic; same input → same
      // hash so forensic correlation works across sweep runs). Base64url
      // output keeps the column shape sane (~43 chars after 'sha256:'
      // prefix). Falls back to plain SHA-256 if salt is empty (boot
      // guard in env.ts blocks this in production).
      if (salt.length === 0) {
        return createHash('sha256').update(input).digest('base64url').slice(0, 43);
      }
      return createHmac('sha256', salt).update(input).digest('base64url').slice(0, 43);
    },
  };
}

async function listKnownTenants(): Promise<ReadonlyArray<string>> {
  return [env.tenant.slug];
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Security review 2026-05-17 closure: use shared gateCronBearerOrRespond
  // (constant-time bearer compare + IP rate-limit + cron_bearer_auth_rejected
  // audit emit) instead of inline verifyCronBearer. Restores forensic
  // coverage parity with the sweep-error-csv-blobs cron precedent.
  const gate = await gateCronBearerOrRespond(request, {
    route: ROUTE,
    metricsCounter: () => eventcreateMetrics.cronAuditEmitFailed(ROUTE),
    rateLimitFallbackCounter: () => eventcreateMetrics.cronRedisFallback(ROUTE),
  });
  if (gate) return gate;

  if (!env.features.f6EventCreate) {
    return NextResponse.json({ ok: true, skipped: 'feature_off' }, { status: 200 });
  }

  const salt = env.eventcreate.piiPseudonymSalt;
  if (!salt) {
    logger.error(
      { event: 'pseudonymise_sweep_missing_salt' },
      '[F6] pseudonymise sweep: EVENTCREATE_PII_PSEUDONYM_SALT is required',
    );
    return NextResponse.json(
      { error: 'misconfigured', detail: 'pseudonym salt unset' },
      { status: 500 },
    );
  }
  const hasher = makeHasher(salt);
  const occurredAt = new Date();
  const tenants = await listKnownTenants();
  const perTenant: Array<{
    tenantId: string;
    outcome: 'success' | 'error';
    rowsScanned?: number;
    rowsPseudonymised?: number;
    durationMs?: number;
    message?: string;
  }> = [];

  for (const tenantSlug of tenants) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const tenantId = asTenantId(tenantSlug);
      const result = await runInTenant(ctx, async (tx) => {
        return pseudonymiseStaleNonMemberPii(
          { tenantId, occurredAt },
          makePseudonymiseStaleNonMemberPiiDeps(tx, hasher),
        );
      });
      if (result.ok) {
        eventcreateMetrics.pseudonymisationSweepRowsTotal(
          tenantSlug,
          result.value.rowsPseudonymised > 0 ? 'pseudonymised' : 'skipped_not_eligible',
        );
        // If we actually pseudonymised some rows, also emit a counter
        // event PER row for dashboard granularity.
        if (result.value.rowsPseudonymised > 1) {
          for (let i = 1; i < result.value.rowsPseudonymised; i++) {
            eventcreateMetrics.pseudonymisationSweepRowsTotal(
              tenantSlug,
              'pseudonymised',
            );
          }
        }
        perTenant.push({
          tenantId: tenantSlug,
          outcome: 'success',
          rowsScanned: result.value.rowsScanned,
          rowsPseudonymised: result.value.rowsPseudonymised,
          durationMs: result.value.durationMs,
        });
      } else {
        eventcreateMetrics.pseudonymisationSweepRowsTotal(tenantSlug, 'error');
        // Mirror the catch sibling's logger.error so SRE dashboards
        // surface the failure (Result.err branch was previously silent).
        logger.error(
          {
            event: 'pseudonymise_sweep_per_tenant_use_case_err',
            tenantSlug,
            errKind: result.error.kind,
            errMessage: result.error.message,
          },
          '[F6] pseudonymise sweep: per-tenant use-case returned Result.err',
        );
        perTenant.push({
          tenantId: tenantSlug,
          outcome: 'error',
          message: result.error.message,
        });
      }
    } catch (e) {
      eventcreateMetrics.pseudonymisationSweepRowsTotal(tenantSlug, 'error');
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        { event: 'pseudonymise_sweep_per_tenant_throw', tenantSlug, err: message },
        '[F6] pseudonymise sweep: per-tenant tx threw',
      );
      perTenant.push({ tenantId: tenantSlug, outcome: 'error', message });
    }
  }

  // If ANY tenant errored, return HTTP 500 so cron-job.org's
  // "≥2 consecutive non-200" alert fires. The per-tenant array is
  // preserved in the response body for forensic correlation. Mirrors
  // the sweep-error-csv-blobs scan-failure precedent.
  const anyErrored = perTenant.some((t) => t.outcome === 'error');
  if (anyErrored) {
    return NextResponse.json(
      { ok: false, error: 'pseudonymise_sweep_per_tenant_errors', perTenant },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, perTenant }, { status: 200 });
}
