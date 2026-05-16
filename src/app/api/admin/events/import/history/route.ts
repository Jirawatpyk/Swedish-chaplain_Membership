/**
 * T042 (F6.1 · Feature 013 — Phase 5 US5) —
 * GET `/api/admin/events/import/history`
 *
 * Spec: specs/013-csv-import-eventcreate-format/contracts/csv-import-history-api.md
 *
 * Admin-only read-only endpoint that returns a paginated list of past
 * CSV imports for the current tenant. Reverse-chronological by
 * `uploaded_at`. Optional filters by event_id + actor_user_id.
 *
 * Pipeline:
 *   1. Feature-flag gate (FEATURE_F6_EVENTCREATE = false → 503).
 *   2. RBAC guard (admin only — manager/member/no-session → 404).
 *   3. Tenant resolution.
 *   4. Query-param parsing + validation (zod-shaped):
 *        page          — positive int, default 1
 *        perPage       — int in [1,100], default 30
 *        eventId       — optional UUID v4
 *        actorUserId   — optional UUID v4
 *   5. Dispatch `runListCsvImportRecords`.
 *   6. Map outcome to 200 response per contract.
 *
 * Cross-tenant isolation: RLS+FORCE on `csv_import_records` enforces
 * the tenant scope on the SELECT inside `runInTenant(...)` — Tenant A
 * admin querying always sees only Tenant A records, never any of
 * Tenant B's. Verified by `tests/integration/events/csv-import-records-history.test.ts`.
 *
 * No audit emit on list (only the signed-URL endpoint at T043 emits
 * `csv_import_error_csv_downloaded`).
 *
 * Node runtime pinned for Drizzle.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { problemResponse } from '@/lib/http/problem-response';
import { runListCsvImportRecords } from '@/lib/events-csv-import-deps';
import type { UserId } from '@/modules/auth';
import { adminOnlyGuard } from '../../../integrations/eventcreate/_lib/role-violation-audit';

const ROUTE = '/api/admin/events/import/history';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<Response> {
  // 1. Feature-flag gate — 503 (service unavailable) per contract
  //    response 503; cleaner than 404 for a kill-switched feature on a
  //    read-only listing endpoint.
  if (!env.features.f6EventCreate) {
    return problemResponse(
      503,
      'feature-disabled',
      'Service Unavailable',
      'CSV import is temporarily disabled by the kill-switch. Try again later.',
    );
  }

  // 2. RBAC — admin only; manager/member/no-session → 404.
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'csv_import_history_list',
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
        event: 'f6_csv_history_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6.1] resolveTenantFromRequest threw on CSV history route',
    );
    return new NextResponse(null, { status: 404 });
  }

  // 4. Parse + validate query params.
  const url = new URL(request.url);
  const pageRaw = url.searchParams.get('page');
  const perPageRaw = url.searchParams.get('perPage');
  const eventIdRaw = url.searchParams.get('eventId');
  const actorUserIdRaw = url.searchParams.get('actorUserId');

  const page = pageRaw === null ? 1 : Number.parseInt(pageRaw, 10);
  const perPage =
    perPageRaw === null ? DEFAULT_PER_PAGE : Number.parseInt(perPageRaw, 10);

  if (!Number.isInteger(page) || page < 1) {
    return problemResponse(
      400,
      'invalid-page',
      'Invalid pagination',
      `'page' must be a positive integer; received '${pageRaw}'.`,
      { extras: { requestId } },
    );
  }
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) {
    return problemResponse(
      400,
      'invalid-per-page',
      'Invalid pagination',
      `'perPage' must be an integer in [1, ${MAX_PER_PAGE}]; received '${perPageRaw}'.`,
      { extras: { requestId } },
    );
  }
  if (eventIdRaw !== null && !UUID_V4_PATTERN.test(eventIdRaw)) {
    return problemResponse(
      400,
      'invalid-event-id',
      'Invalid filter',
      `'eventId' must be a UUID v4; received '${eventIdRaw}'.`,
      { extras: { requestId } },
    );
  }
  if (actorUserIdRaw !== null && !UUID_V4_PATTERN.test(actorUserIdRaw)) {
    return problemResponse(
      400,
      'invalid-actor-user-id',
      'Invalid filter',
      `'actorUserId' must be a UUID v4; received '${actorUserIdRaw}'.`,
      { extras: { requestId } },
    );
  }

  // 5. Dispatch use-case.
  const result = await runListCsvImportRecords({
    tenantSlug,
    page,
    perPage,
    ...(eventIdRaw !== null && { eventIdFilter: eventIdRaw }),
    ...(actorUserIdRaw !== null && {
      actorUserIdFilter: actorUserIdRaw as UserId,
    }),
  });

  if (!result.ok) {
    logger.error(
      {
        event: 'f6_csv_history_list_failed',
        tenantSlug,
        actorUserId: guard.actorUserId,
        requestId,
        err: result.error,
      },
      '[F6.1] CSV history list use-case failed',
    );
    return problemResponse(
      500,
      'internal',
      'Internal Server Error',
      'Could not load CSV import history. Try again in a moment.',
      { extras: { requestId } },
    );
  }

  // 6. Map outcome to contract response body.
  const body = {
    records: result.value.rows.map((row) => ({
      recordId: row.record.recordId,
      uploadedAt: row.record.uploadedAt.toISOString(),
      actor: { userId: row.record.actorUserId },
      event: { eventId: row.record.eventId },
      sourceFormat: row.record.sourceFormat,
      originalFilename: row.record.originalFilename,
      originalSizeBytes: row.record.originalSizeBytes,
      counts: {
        total: row.record.rowsTotal,
        processed: row.record.rowsProcessed,
        alreadyImported: row.record.rowsAlreadyImported,
        skipped: row.record.rowsSkipped,
        failed: row.record.rowsFailed,
      },
      outcome: row.record.outcome,
      durationMs: row.record.durationMs,
      errorCsvAvailable: row.errorCsvAvailable,
      errorCsvExpiresAt: row.record.errorCsvExpiresAt?.toISOString() ?? null,
    })),
    pagination: result.value.pagination,
  } as const;

  return NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
