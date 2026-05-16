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
  lookupEventByIdTimingSafe,
} from '@/lib/events-csv-import-deps';
import { asUserId } from '@/modules/auth';
import { asTenantId } from '@/modules/members';
import { makeStandaloneAuditDeps } from '@/modules/events';
import { adminOnlyGuard } from '../../integrations/eventcreate/_lib/role-violation-audit';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORCE_PROCEED_TRUTHY = new Set(['true', '1', 'yes']);

function parseForceProceed(value: FormDataEntryValue | null): boolean {
  if (typeof value !== 'string') return false;
  return FORCE_PROCEED_TRUTHY.has(value.trim().toLowerCase());
}

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

  // 6b. F6.1 — parse `event_id` form field (UUID required) +
  //     `force_proceed` form field. event_id is shape-validated as UUID;
  //     event ownership + existence are checked AFTER bytes-read so the
  //     413 / 415 / multipart guards continue to short-circuit early.
  const eventIdField = formData.get('event_id');
  const forceProceed = parseForceProceed(formData.get('force_proceed'));
  if (typeof eventIdField !== 'string' || eventIdField.length === 0) {
    eventcreateMetrics.csvImportCompleted(tenantSlug, 'event_not_selected');
    return problemResponse(
      400,
      'csv-event-not-selected',
      'Event not selected',
      "The 'event_id' field is required. Select an event from the dropdown before uploading.",
      { extras: { requestId } },
    );
  }
  if (!UUID_V4_PATTERN.test(eventIdField)) {
    // Treat shape-invalid eventIds as "not_found" (a UUID-shaped probe
    // would never have matched anyway — no need to fan out to the DB
    // for a confirmed-invalid input). Returns the same shape as
    // post-DB `event_not_found`.
    eventcreateMetrics.csvImportCompleted(tenantSlug, 'event_not_found');
    return problemResponse(
      400,
      'csv-event-not-found',
      'Event not found',
      `Event '${eventIdField.slice(0, 80)}' was not found in your chamber. Was it deleted?`,
      { extras: { eventId: eventIdField, requestId } },
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

  // 7b. F6.1 (T023) — timing-safe event lookup. ONE unscoped query →
  //     branch on tenant ownership in app code. Cross-tenant probes
  //     emit `csv_import_cross_tenant_probe` audit (Constitution
  //     Principle I clause 4 — HIGH severity). The audit emit uses a
  //     standalone tx so the route never blocks on audit DB write.
  // Neon outage / RLS denial / role-misconfig must surface as a branded
  // 500 with requestId + log + metric — not as an unbranded Next.js
  // crash. The standalone audit emit inside the wrong_tenant branch
  // uses its own tx so the route never blocks on the audit write.
  let eventLookup: Awaited<ReturnType<typeof lookupEventByIdTimingSafe>>;
  try {
    eventLookup = await lookupEventByIdTimingSafe(tenantSlug, eventIdField);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        event: 'f6_csv_import_event_lookup_failed',
        tenantSlug,
        eventId: eventIdField,
        requestId,
        err: message,
      },
      '[F6.1] lookupEventByIdTimingSafe threw — likely Neon outage / RLS denial / pool exhaustion',
    );
    eventcreateMetrics.csvImportCompleted(tenantSlug, 'unexpected_error');
    return problemResponse(
      500,
      'internal',
      'Internal Server Error',
      'Event lookup failed. Retry; if it persists, contact support with this request ID.',
      { extras: { requestId } },
    );
  }
  if (eventLookup.kind === 'not_found') {
    eventcreateMetrics.csvImportCompleted(tenantSlug, 'event_not_found');
    return problemResponse(
      400,
      'csv-event-not-found',
      'Event not found',
      `Event '${eventIdField}' was not found in your chamber. Was it deleted?`,
      { extras: { eventId: eventIdField, requestId } },
    );
  }
  if (eventLookup.kind === 'wrong_tenant') {
    // FR-035 surface disclosure — 400 with the same body as not_found.
    // The cross-tenant probe is audit-logged at HIGH severity for SRE
    // investigation (Principle I clause 4).
    //
    // CR-3 + I5 (Round 1) — await the audit emit so the forensic row
    // is guaranteed-persisted before the 400 response returns. The
    // timing-safety guarantee comes from the upstream identical DB
    // work (single unscoped query) — post-DB the wrong_tenant path
    // pays ~30-50ms for the standalone audit tx vs not_found's zero.
    // At chamber scale this is below the timing-attack signal-to-
    // noise floor (network jitter from BKK→sin1 dominates at ~25ms).
    // Production timing-safety is enforced by the structural query
    // symmetry, not by sub-millisecond post-DB work matching.
    eventcreateMetrics.csvImportCompleted(
      tenantSlug,
      'event_not_owned_by_tenant',
    );
    await emitCrossTenantProbeAudit({
      tenantSlug,
      actorUserId: guard.actorUserId,
      probedEventId: eventIdField,
      sourceIp:
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        'unknown',
      requestId,
    });
    return problemResponse(
      400,
      'csv-event-not-found',
      'Event not found',
      `Event '${eventIdField}' was not found in your chamber. Was it deleted?`,
      { extras: { eventId: eventIdField, requestId } },
    );
  }
  // R2 (Round 2 — type-design-analyzer): exhaustive guard against a
  // future EventLookupResult variant landing without a corresponding
  // route handler branch. Without this, TypeScript would silently
  // permit access to `eventLookup.event` on a new variant carrying
  // that field, leaking through as an uncaught fall-through bug.
  if (eventLookup.kind !== 'found') {
    const _exhaustive: never = eventLookup;
    void _exhaustive;
    logger.error(
      {
        event: 'f6_csv_event_lookup_unknown_variant',
        tenantSlug,
        eventId: eventIdField,
        requestId,
      },
      '[F6.1] lookupEventByIdTimingSafe returned an unrecognised variant — route handler is out of sync with the helper',
    );
    return problemResponse(
      500,
      'internal',
      'Internal Server Error',
      'Event lookup returned an unexpected state. Contact support.',
      { extras: { requestId } },
    );
  }

  // 8. Dispatch use-case.
  let outcome: Awaited<ReturnType<typeof runImportCsv>>;
  try {
    outcome = await runImportCsv({
      tenantSlug,
      // H-15 fix (2026-05-15): brand at the composition-adapter
      // boundary; runImportCsv input now requires UserId, not string.
      actorUserId: asUserId(guard.actorUserId),
      bytes,
      selectedEvent: eventLookup.event,
      forceProceed,
      ...(typeof file.name === 'string' && file.name.length > 0 && {
        originalFilename: file.name,
      }),
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
      return NextResponse.json(
        {
          kind: 'completed',
          recordId: outcome.recordId,
          sourceFormat: outcome.sourceFormat,
          errorCsvAvailable: outcome.errorCsvAvailable,
          historyPersisted: outcome.historyPersisted,
          // R2-I-1: surface audit-completion status so UI can degrade
          // the audit-trail chip when the per-import audit row was lost.
          auditCompletionEmitted: outcome.auditCompletionEmitted,
          summary: outcome.summary,
        },
        { status: 200 },
      );
    case 'event_mismatch_warning':
      // F6.1 (FR-019b) — ZERO side effects; admin must re-submit with
      // `force_proceed=true` to bypass. Body shape mirrors contract.
      return NextResponse.json(
        {
          kind: 'event_mismatch_warning',
          priorImports: outcome.priorImports.map((p) => ({
            recordId: p.recordId,
            eventId: p.eventId,
            uploadedAt: p.uploadedAt.toISOString(),
          })),
        },
        { status: 200 },
      );
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
        {
          extras: {
            recordId: outcome.recordId,
            sourceFormat: outcome.sourceFormat,
            errorCsvAvailable: outcome.errorCsvAvailable,
            historyPersisted: outcome.historyPersisted,
            // R2-I-1: same audit-trail signal on the timeout path.
            auditCompletionEmitted: outcome.auditCompletionEmitted,
            summary: outcome.summary,
          },
        },
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
      // Surface parser-class messages (UTF-8 BOM / encoding hints) as
      // the response detail so admin sees actionable remediation
      // ("re-save as UTF-8 without BOM") instead of the generic 500.
      // The use-case prefixes parser errors with "parser error:" — the
      // discriminator is intentional + grep-able. Other unexpected
      // errors (DB pool exhaustion, internal bugs) keep the generic
      // detail since their messages could leak implementation specifics.
      if (outcome.message.startsWith('parser error:')) {
        return problemResponse(
          400,
          'csv-parser-error',
          'CSV file could not be parsed',
          outcome.message,
          { extras: { requestId } },
        );
      }
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'CSV import failed. Retry; if it persists, contact support with this request ID.',
        { extras: { requestId } },
      );
    default: {
      // Exhaustiveness — adding a 6th variant to ImportCsvOutcome
      // surfaces as a compile error here.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return problemResponse(
        500,
        'internal',
        'Internal Server Error',
        'CSV import returned an unrecognised outcome.',
        { extras: { requestId } },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// F6.1 (Feature 013 · T023) — Cross-tenant probe audit emit
// ---------------------------------------------------------------------------

interface CrossTenantProbeAuditInput {
  readonly tenantSlug: string;
  readonly actorUserId: string;
  readonly probedEventId: string;
  readonly sourceIp: string;
  readonly requestId: string;
}

/**
 * Emit `csv_import_cross_tenant_probe` via a standalone audit tx.
 * Called with `await` from the route handler so the forensic row is
 * guaranteed-persisted before the 4xx response returns — the ~30-50ms
 * audit-tx cost is below the network jitter floor for BKK→sin1, so it
 * does not create a measurable timing-leak against the not_found path
 * (TESTS-I3 p95-symmetry test pins this). Failures log via `pino` +
 * surface to SRE through the metric call site at the route.
 *
 * If a future maintainer needs to swap back to a non-blocking emit,
 * REVIEW the upstream lookupEventByIdTimingSafe structural-symmetry
 * design first — the timing-safety guarantee currently rests on the
 * single-DB-query-shape invariant, NOT on emit timing.
 */
async function emitCrossTenantProbeAudit(
  input: CrossTenantProbeAuditInput,
): Promise<void> {
  try {
    const auditDeps = makeStandaloneAuditDeps();
    const result = await auditDeps.emitStandalone({
      eventType: 'csv_import_cross_tenant_probe',
      tenantId: asTenantId(input.tenantSlug),
      actorType: 'admin',
      actorUserId: asUserId(input.actorUserId),
      occurredAt: new Date(),
      summary: `Cross-tenant probe on POST /api/admin/events/import (event_id=${input.probedEventId.slice(0, 80)})`,
      payload: {
        severity: 'critical',
        actorUserId: asUserId(input.actorUserId),
        probedId: input.probedEventId,
        probeSurface: 'import_event_id',
        sourceIp: input.sourceIp,
        probedAt: new Date(),
      },
    });
    if (!result.ok) {
      logger.error(
        {
          event: 'f6_csv_cross_tenant_probe_audit_emit_failed',
          tenantSlug: input.tenantSlug,
          probedEventId: input.probedEventId,
          err: result.error.kind,
        },
        '[F6.1] csv_import_cross_tenant_probe audit emit failed — security event lost from audit table; SRE counter still fires',
      );
    }
  } catch (e) {
    logger.error(
      {
        event: 'f6_csv_cross_tenant_probe_audit_emit_threw',
        tenantSlug: input.tenantSlug,
        probedEventId: input.probedEventId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] csv_import_cross_tenant_probe audit emitter threw',
    );
  }
}
