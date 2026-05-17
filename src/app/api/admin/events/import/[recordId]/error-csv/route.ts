/**
 * T043 (F6.1 · Feature 013 — Phase 5 US5) —
 * GET `/api/admin/events/import/{recordId}/error-csv`
 *
 * Spec: specs/013-csv-import-eventcreate-format/contracts/error-csv-signed-url-api.md
 *
 * Admin-only endpoint that issues a 15-minute Vercel Blob signed URL
 * for the error-CSV from a past import. Emits a
 * `csv_import_error_csv_downloaded` audit BEFORE the redirect (strict-
 * audit invariant — PDPA/GDPR PII-access trail).
 *
 * Pipeline:
 *   1. Feature-flag gate (FEATURE_F6_EVENTCREATE = false → 503).
 *   2. RBAC guard (admin only).
 *   3. Tenant resolution.
 *   4. UUID v4 shape-validate `recordId` path param.
 *   5. Dispatch `runGenerateErrorCsvSignedUrl` use-case.
 *   6. Map outcome:
 *        success         → 307 redirect to signed URL
 *        not_found       → 404 ProblemDetails (same body for cross-tenant)
 *        expired         → 404 ProblemDetails (same body)
 *        signing_failure → 500 ProblemDetails
 *
 * Cross-tenant probes: detected inside the use-case via the
 * admin-bypass `findByIdAcrossTenants` repo + emit a
 * `csv_import_cross_tenant_probe` HIGH-severity audit. The actor
 * always sees the same 404 body — surface-disclosure invariant.
 *
 * Node runtime pinned for Drizzle + Vercel Blob.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { problemResponse } from '@/lib/http/problem-response';
import { runGenerateErrorCsvSignedUrl } from '@/lib/events-csv-import-deps';
import { errorCsvDownloadRateLimitCheck } from '@/lib/events-admin-integration-deps';
import { eventcreateMetrics } from '@/lib/metrics';
import { asUserId } from '@/modules/auth';
import { adminOnlyGuard } from '../../../../integrations/eventcreate/_lib/role-violation-audit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NOT_FOUND_PROBLEM_TYPE =
  'https://chamber-os.app/errors/error-csv-not-available';
const NOT_FOUND_TITLE = 'Error CSV not available';
const NOT_FOUND_DETAIL =
  'The error CSV for this import has either been removed or never existed. Re-run the import to generate fresh error rows.';

export const runtime = 'nodejs';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ recordId: string }> },
): Promise<Response> {
  // 1. Feature-flag gate.
  if (!env.features.f6EventCreate) {
    return problemResponse(
      503,
      'feature-disabled',
      'Service Unavailable',
      'CSV import is temporarily disabled by the kill-switch. Try again later.',
    );
  }

  // 2. RBAC — admin only.
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: '/api/admin/events/import/{recordId}/error-csv',
    attemptedAction: 'csv_import_error_csv_download',
  });
  if (guard.kind === 'deny') return guard.response;

  const requestId = crypto.randomUUID();

  // 3. Tenant resolution.
  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'f6_error_csv_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6.1] resolveTenantFromRequest threw on error-csv route',
    );
    return new NextResponse(null, { status: 404 });
  }

  // 4. UUID shape-validate recordId.
  const { recordId } = await context.params;
  if (!UUID_V4_PATTERN.test(recordId)) {
    return problemResponse(
      404,
      'error-csv-not-available',
      NOT_FOUND_TITLE,
      NOT_FOUND_DETAIL,
      { extras: { requestId, type: NOT_FOUND_PROBLEM_TYPE } },
    );
  }

  // R6.W / Round 5 staff-review R011 (T-11) closure — rate-limit
  // PII bulk-download via compromised admin sessions. 20/hr per
  // (tenant, actor). The audit log still records every successful
  // download (csv_import_error_csv_downloaded) — this limiter bounds
  // the throughput before audit trail gets noisy.
  const rl = await errorCsvDownloadRateLimitCheck(
    tenantSlug,
    guard.actorUserId,
  );
  if (!rl.success) {
    eventcreateMetrics.csvErrorCsvDownloadRateLimitExceeded(tenantSlug);
    const retryAfter = Math.max(
      1,
      Math.ceil((rl.resetAtUnixMs - Date.now()) / 1000),
    );
    return problemResponse(
      429,
      'rate-limited',
      'Too many requests',
      `Error-CSV download rate limit exceeded (20/hr). Retry after ${retryAfter}s.`,
      {
        extras: { requestId },
        headers: { 'Retry-After': retryAfter.toString() },
      },
    );
  }

  // 5. Dispatch use-case.
  // simplifier M6 (R1 R2): inline one-call XFF parse — first hop +
  // trim. Empty string when header missing so the audit payload stays
  // typed as `string` (not nullable); analysts read empty = unknown.
  const sourceIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '';
  const outcome = await runGenerateErrorCsvSignedUrl({
    tenantSlug,
    actorUserId: asUserId(guard.actorUserId),
    recordId,
    sourceIp,
  });

  // 6. Map outcome.
  switch (outcome.kind) {
    case 'success':
      return new Response(null, {
        status: 307,
        headers: {
          Location: outcome.signedUrl,
          'Cache-Control': 'no-store',
        },
      });
    case 'not_found':
    case 'expired':
      return problemResponse(
        404,
        'error-csv-not-available',
        NOT_FOUND_TITLE,
        NOT_FOUND_DETAIL,
        { extras: { requestId, type: NOT_FOUND_PROBLEM_TYPE } },
      );
    case 'signing_failure':
      logger.error(
        {
          event: 'f6_error_csv_route_signing_failure',
          tenantSlug,
          recordId,
          actorUserId: guard.actorUserId,
          requestId,
          message: outcome.message,
        },
        '[F6.1] error-CSV signed-URL endpoint returned 500 (signing or audit emit failed)',
      );
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'Could not generate download link. Try again in a moment; if this persists, contact support with this request ID.',
        { extras: { requestId } },
      );
  }
}

