/**
 * T095 — POST `/api/admin/events/import` (CSV bulk import).
 *
 * Spec: specs/012-eventcreate-integration/contracts/csv-import-api.md
 *
 * Admin-only mutation. Rate-limited 5/hr per (tenant, actor) per
 * FR-005 + contracts. Accepts multipart/form-data with a single `file`
 * field. Pipeline:
 *
 *   1. Feature-flag gate (FEATURE_F6_EVENTCREATE = false → 404).
 *   2. RBAC guard (admin only — manager/member/no-session → 404 +
 *      `role_violation_blocked` audit). Mirrors the F6
 *      `adminOnlyGuard` precedent under
 *      `src/app/api/admin/integrations/eventcreate/_lib/role-violation-audit.ts`.
 *   3. Rate-limit (5/hr per (tenant, actor) → 429 + Retry-After).
 *   4. Content-Length pre-check (> 5 MiB → 413; saves multipart parse).
 *   5. `request.formData()` (multipart parse failure → 400 invalid_multipart).
 *   6. Pull `file` field (not a File instance → 400 missing_file_field).
 *   7. Materialise bytes via `file.arrayBuffer()` + post-realisation
 *      size cap (chunked-transfer guard → 413).
 *   8. Dispatch `runImportCsv` use-case.
 *   9. Map outcome to HTTP:
 *        - completed       → 200 + ImportSummary body
 *        - invalid_header  → 400 + RFC 7807 problem (missingColumns[])
 *        - timeout         → 504 + recovery copy
 *        - unexpected_error → 500
 *  10. Emit `eventcreate_csv_import_completed_total` + duration
 *      histogram regardless of outcome (route-level boundary
 *      observability per FR-036).
 *
 * Node runtime pinned for Drizzle + crypto + multipart parser.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { problemResponse } from '@/lib/http/problem-response';
import {
  runImportCsv,
  csvImportRateLimitCheck,
} from '@/lib/events-csv-import-deps';
import { asUserId } from '@/modules/auth';
import { adminOnlyGuard } from '../../integrations/eventcreate/_lib/role-violation-audit';

const ROUTE = '/api/admin/events/import';
const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB per contracts § Processing semantics step 1

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<Response> {
  // 1. Feature-flag gate — surface-disclosure 404 when F6 is off.
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  // 2. RBAC — admin-only; manager/member/no-session all → 404 with
  // `role_violation_blocked` audit (emitted async + non-blocking).
  const guard = await adminOnlyGuard(request, {
    attemptedRoute: ROUTE,
    attemptedAction: 'csv_import',
  });
  if (guard.kind === 'deny') return guard.response;

  // Round 3 H1-equivalent — issue a request ID so 500 problem bodies
  // carry a forensic correlation identifier the admin can quote.
  const requestId = crypto.randomUUID();
  const startedAtMs = Date.now();

  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'f6_csv_import_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        requestId,
      },
      '[F6] resolveTenantFromRequest threw on CSV import route',
    );
    return new NextResponse(null, { status: 404 });
  }

  // 3. Rate-limit (5/hr per (tenant, actor)).
  const rl = await csvImportRateLimitCheck(tenantSlug, guard.actorUserId);
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl({ reset: rl.resetAtUnixMs });
    return problemResponse(
      429,
      'rate-limited',
      'Too many requests',
      `CSV-import rate limit (5/hour per admin) exceeded. Retry after ${retryAfter}s.`,
      { headers: { 'Retry-After': retryAfter.toString() } },
    );
  }

  // 4. Content-Length pre-check — early 413 before multipart parse.
  // The multipart boundary + form-data envelope add ~200 bytes of
  // overhead so we allow Content-Length up to MAX_BYTES * 1.05 here;
  // the post-parse check (step 7) enforces the real cap on the file
  // bytes themselves.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES * 1.05 + 1024) {
      return problemResponse(
        413,
        'file-too-large',
        'Payload too large',
        `Declared Content-Length ${declared} exceeds the 5 MiB cap (5,242,880 bytes).`,
      );
    }
  }

  // 5. Content-Type sanity check — multipart/form-data only.
  // Use the request's content-type header rather than `formData()`
  // exception messages so we can return 415 (not 400) for
  // application/json / text/plain bodies.
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return problemResponse(
      415,
      'unsupported-media-type',
      'Unsupported Media Type',
      'CSV import requires multipart/form-data with a single `file` field.',
    );
  }

  // 6. Parse multipart.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (e) {
    logger.warn(
      {
        event: 'f6_csv_import_invalid_multipart',
        err: e instanceof Error ? e.message : String(e),
        tenantSlug,
        requestId,
      },
      '[F6] CSV import multipart parse failed',
    );
    return problemResponse(
      400,
      'invalid-multipart',
      'Bad Request',
      'Could not parse multipart/form-data body. Re-upload the CSV.',
    );
  }

  // 7. Pull `file` field + bytes. Duck-type check on `arrayBuffer`
  // method to avoid cross-realm `instanceof File` mismatches (undici's
  // File class is distinct from Vitest's global File polyfill); a
  // string value indicates a non-file form field which also fails the
  // duck-type check.
  const fileField = formData.get('file');
  if (
    fileField === null ||
    typeof fileField === 'string' ||
    typeof (fileField as { arrayBuffer?: unknown }).arrayBuffer !== 'function'
  ) {
    return problemResponse(
      400,
      'missing-file-field',
      'Bad Request',
      'CSV import requires a single `file` field in the multipart body.',
    );
  }
  const file = fileField as {
    arrayBuffer: () => Promise<ArrayBuffer>;
    size: number;
    name?: string;
    type?: string;
  };

  // H-4 fix (2026-05-15): wrap arrayBuffer() to catch AbortError /
  // socket reset / RangeError / OOM. Without the try/catch a mid-upload
  // disconnect bubbles to Next.js as a generic 500 with no requestId,
  // no log line, and no metric increment — admin retries blindly.
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = await file.arrayBuffer();
  } catch (e) {
    logger.warn(
      {
        event: 'f6_csv_import_body_read_failed',
        err: e instanceof Error ? e.message : String(e),
        tenantSlug,
        requestId,
      },
      '[F6] CSV import file.arrayBuffer() failed — upload likely interrupted',
    );
    return problemResponse(
      400,
      'body-read-failed',
      'Bad Request',
      'Could not read the uploaded file body. The upload may have been interrupted — please re-upload the CSV.',
      { extras: { requestId } },
    );
  }
  if (arrayBuffer.byteLength > MAX_BYTES) {
    return problemResponse(
      413,
      'file-too-large',
      'Payload too large',
      `File size ${arrayBuffer.byteLength} bytes exceeds the 5 MiB cap (5,242,880 bytes).`,
    );
  }
  const bytes = new Uint8Array(arrayBuffer);

  // 8. Dispatch use-case.
  let outcome: Awaited<ReturnType<typeof runImportCsv>>;
  try {
    outcome = await runImportCsv({
      tenantSlug,
      // H-15 fix (2026-05-15): brand at the composition-adapter
      // boundary; runImportCsv input now requires UserId, not string.
      actorUserId: asUserId(guard.actorUserId),
      bytes,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        event: 'f6_csv_import_threw',
        tenantSlug,
        requestId,
        err: message,
      },
      '[F6] CSV import use-case threw',
    );
    eventcreateMetrics.csvImportCompleted(tenantSlug, 'unexpected_error');
    eventcreateMetrics.csvImportDurationSeconds(
      tenantSlug,
      (Date.now() - startedAtMs) / 1000,
    );
    return problemResponse(
      500,
      'internal',
      'Internal Server Error',
      'CSV import failed unexpectedly. Retry; if it persists, contact support with this request ID.',
      { extras: { requestId } },
    );
  }

  const durationSeconds = (Date.now() - startedAtMs) / 1000;
  eventcreateMetrics.csvImportCompleted(tenantSlug, outcome.kind);
  eventcreateMetrics.csvImportDurationSeconds(tenantSlug, durationSeconds);

  // 9. Map outcome.
  switch (outcome.kind) {
    case 'completed':
      return NextResponse.json(outcome.summary, { status: 200 });
    case 'invalid_header':
      return NextResponse.json(
        {
          type: 'https://chamber-os.app/errors/csv-header-invalid',
          title: 'CSV header row is invalid',
          status: 400,
          missingColumns: outcome.missingColumns,
        },
        { status: 400 },
      );
    case 'timeout':
      return problemResponse(
        504,
        'csv-timeout',
        'CSV import exceeded time budget',
        'Import partially completed. Re-upload the same CSV — already-processed rows are idempotent and will be skipped.',
      );
    case 'unexpected_error':
      logger.error(
        {
          event: 'f6_csv_import_unexpected_error',
          tenantSlug,
          requestId,
          message: outcome.message,
        },
        '[F6] CSV import use-case returned unexpected_error',
      );
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'CSV import failed. Retry; if it persists, contact support with this request ID.',
        { extras: { requestId } },
      );
  }
}
