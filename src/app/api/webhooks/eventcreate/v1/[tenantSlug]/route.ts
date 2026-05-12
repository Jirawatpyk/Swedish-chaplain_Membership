/**
 * POST /api/webhooks/eventcreate/v1/[tenantSlug] — F6 receiver.
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/webhook-eventcreate-api.md
 *   - FR-001..FR-013, FR-037
 *
 * Pipeline (owns steps 0–8; `ingestWebhookAttendee` use-case starts at
 * step 9):
 *   0. Tenant slug shape validation → 404 BEFORE any metric emit (avoids
 *      OTel cardinality bomb on unbounded slug labels).
 *   1. Content-Type check → 415 on non-JSON.
 *   2. Body-size pre-check (Content-Length) → 413 before read.
 *   3. Raw body read (HMAC needs unparsed bytes) — wrapped in try/catch
 *      so a body-read failure surfaces as a logged 400, not a silent
 *      Next.js default 500.
 *   3.5 Post-read realised-size cap → 413.
 *   4. Rate-limit check (60 req/min per tenant, FR-005) → 429 + Retry-After.
 *   5. Tenant context build + load webhook config → 404 if missing,
 *      audited 500 on DB failure.
 *   6. Enabled check → 503 + Retry-After: 3600 if disabled (FR-033).
 *   7. Signature verify → 401 generic body on any failure (no oracle).
 *      Emits `webhook_signature_rejected` standalone audit via the
 *      minimal `makeStandaloneAuditDeps()` factory (avoids
 *      instantiating the full Drizzle adapter stack on the hot reject
 *      path).
 *   8. JSON parse → 400 on malformed payload.
 *   9. Dispatch to `ingestWebhookAttendee` strict-transactional use-case.
 *  10. Map result to HTTP + emit `ingestLatencyMs` histogram + close
 *      OTel `webhook_ingest_eventcreate` span.
 *
 * Runtime: Node.js (NOT Edge) — needs raw body for HMAC verify + full
 * Node `crypto.timingSafeEqual` + Drizzle pool access.
 *
 * Security:
 *   - All 401 paths return identical generic body (no signature oracle).
 *   - Discriminator captured in audit log only (forensic use).
 *   - Forbidden in logs: webhook secrets, signature header value,
 *     attendee_email (pino redact list).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { eventsTracer } from '@/lib/otel-tracer';
import { asTenantId } from '@/modules/members';
import { TENANT_SLUG_PATTERN } from '@/modules/tenants';
import {
  verifyWebhookSignature,
  cryptoWebhookSignatureVerifier,
  ingestWebhookAttendee,
  MATCH_TYPE_TO_PROCESSING_OUTCOME,
  type StandaloneAuditDeps,
  type F6AuditEventType,
  type F6AuditEntry,
} from '@/modules/events';
import {
  makeIngestWebhookAttendeeDeps,
  makeStandaloneAuditDeps,
  ratelimitCheck,
  loadTenantWebhookConfig,
  resolveTenantFromSlug,
} from '@/lib/events-webhook-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024; // 64 KiB — matches F5 cap

/**
 * Sentinel that replaces an empty / whitespace-only X-Request-ID
 * header. The `audit_log.request_id` column is forensically indexed
 * and accepts empty strings (NOT NULL doesn't reject `''`), but
 * empty values pollute correlation queries — they're semantically
 * equivalent to missing data. This sentinel reduces audit-row noise
 * to a single bounded-cardinality marker. Distinguishability from a
 * genuine `X-Request-ID: no-request-id` header is a known accepted
 * trade-off (vanishingly unlikely in production Zapier headers).
 */
const NO_REQUEST_ID = 'no-request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Response helpers — keep the body shapes pinned to
// contracts/webhook-eventcreate-api.md.
// ---------------------------------------------------------------------------

function bodyOversizedResponse(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/payload-too-large',
      title: 'Payload too large',
      status: 413,
      detail: `Webhook body exceeds the ${MAX_WEBHOOK_BODY_BYTES} byte limit.`,
    },
    { status: 413 },
  );
}

function genericUnauthorized(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/webhook-unauthorized',
      title: 'Webhook authentication failed',
      status: 401,
      detail: 'Signature or timestamp validation failed. See audit log for outcome.',
    },
    { status: 401 },
  );
}

function notFoundResponse(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/not-found',
      title: 'Not found',
      status: 404,
    },
    { status: 404 },
  );
}

function ingestDisabledResponse(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/ingest-disabled',
      title: 'Ingest temporarily disabled',
      status: 503,
      detail: 'Tenant ingest is currently paused. Retry later.',
    },
    {
      status: 503,
      headers: { 'Retry-After': '3600' },
    },
  );
}

function badRequestResponse(detail: string): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/malformed-webhook',
      title: 'Bad request',
      status: 400,
      detail,
    },
    { status: 400 },
  );
}

function internalErrorResponse(): NextResponse {
  return NextResponse.json(
    {
      type: 'https://chamber-os.app/errors/internal-error',
      title: 'Internal error',
      status: 500,
    },
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// Signature verify-kind → metric label map (module-level to keep the
// hot path allocation-free).
// ---------------------------------------------------------------------------

const VERIFY_KIND_TO_OUTCOME = {
  missing_signature_header: 'rejected_missing_header',
  missing_timestamp_header: 'rejected_missing_header',
  malformed_timestamp: 'rejected_malformed_timestamp',
  timestamp_skew_exceeded: 'rejected_timestamp_skew',
  signature_mismatch: 'rejected_bad_sig',
} as const satisfies Record<string, Parameters<typeof eventcreateMetrics.webhookReceiptsTotal>[1]>;

// ---------------------------------------------------------------------------
// Standalone-audit emit helper — collapses two near-identical
// try/catch+log blocks for step-5b (config-load) and step-7
// (signature-reject). Audit failure MUST NOT crash the HTTP response,
// so the catch logs + suppresses. See helper JSDoc below for WHY.
// ---------------------------------------------------------------------------

/**
 * Mark an OTel span as ERROR for genuine 500-class failures.
 *
 * Client errors (rate-limit, malformed JSON, signature mismatch) stay
 * `UNSET` per OTel HTTP semantic convention — they're not system
 * failures. The last-resort `catch (e)` at the bottom of POST() sets
 * ERROR directly (bypassing this helper) because the span may already
 * be partially closed by the time uncaught throws bubble up there.
 */
function markSpanError(span: Span, reason: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
}

/**
 * Emit a standalone-tx audit entry from the route layer, suppressing
 * any audit emission failure with a structured log line.
 *
 * Used by the config-load-failed and signature-rejected branches —
 * both are post-decision audit emits where the HTTP response code is
 * already determined. Re-throwing on audit failure would only exchange
 * one observability gap (no audit row) for a worse one (no response
 * + audit row still missing). The composition-root LOUD-failure log
 * lines from `di.ts loudFail` are preserved server-side regardless.
 *
 * Generic `T` preserves the per-event-type payload narrowing from
 * `F6AuditPort.emitStandalone<T>` — a `{eventType, payload}` literal
 * with mismatched payload shape still fails to compile here.
 */
async function safeEmitStandalone<T extends F6AuditEventType>(
  deps: StandaloneAuditDeps,
  entry: F6AuditEntry<T>,
  failCtx: { tenantSlug: string; logEvent: string; logMsg: string },
): Promise<void> {
  try {
    await deps.emitStandalone(entry);
  } catch (auditErr) {
    logger.error(
      {
        event: failCtx.logEvent,
        tenantSlug: failCtx.tenantSlug,
        errName: auditErr instanceof Error ? auditErr.name : 'unknown',
        errMessage: auditErr instanceof Error ? auditErr.message : String(auditErr),
        errStack: auditErr instanceof Error ? auditErr.stack : null,
      },
      failCtx.logMsg,
    );
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ tenantSlug: string }> },
) {
  // --- Step 0a: Resolve params (wrapped — Next.js can theoretically
  //              reject if route-cache / dynamic-segment decode fails)
  let tenantSlug: string;
  try {
    ({ tenantSlug } = await ctx.params);
  } catch (e) {
    logger.error(
      {
        event: 'f6_route_params_failed',
        errName: e instanceof Error ? e.name : 'unknown',
        errMessage: e instanceof Error ? e.message : String(e),
        errStack: e instanceof Error ? e.stack : null,
      },
      '[F6] webhook route params resolution failed — returning 500',
    );
    return internalErrorResponse();
  }

  // --- Step 0b: Slug shape validation (BEFORE any metric emit) ----------
  // Prevents OTel cardinality bombs — an attacker POSTing to
  // `/v1/<arbitrary-string>` would otherwise mint a fresh `tenant`
  // metric label per request and explode the metric backend.
  if (!TENANT_SLUG_PATTERN.test(tenantSlug)) {
    return notFoundResponse();
  }

  const rawRequestId = request.headers.get('x-request-id')?.trim() ?? '';
  const requestId = rawRequestId.length > 0 ? rawRequestId : NO_REQUEST_ID;
  const sourceIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  const startedAtMs = Date.now();
  const tracer = eventsTracer();

  return tracer.startActiveSpan(
    'webhook_ingest_eventcreate',
    {
      attributes: {
        'tenant.id': tenantSlug,
        'f6.source': 'eventcreate',
      },
    },
    async (span) => {
      try {
        // --- Step 1: Content-Type check -----------------------------------
        const contentType = request.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('application/json')) {
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'unsupported_media_type',
          );
          span.setAttribute('f6.outcome', 'unsupported_media_type');
          return NextResponse.json(
            {
              type: 'https://chamber-os.app/errors/unsupported-media-type',
              title: 'Unsupported media type',
              status: 415,
              detail: 'Expected Content-Type: application/json',
            },
            { status: 415 },
          );
        }

        // --- Step 2: Body-size pre-check ---------------------------------
        const contentLengthHeader = request.headers.get('content-length');
        if (contentLengthHeader !== null) {
          const declared = Number.parseInt(contentLengthHeader, 10);
          // Negative or non-finite is also rejected as oversized — an
          // attacker sending `Content-Length: -1` or `: abc` is either
          // malicious or malformed; both deserve a 413.
          if (!Number.isFinite(declared) || declared < 0 || declared > MAX_WEBHOOK_BODY_BYTES) {
            eventcreateMetrics.bodyOversizedTotal(tenantSlug);
            logger.warn(
              { event: 'f6_webhook_body_oversized', tenantSlug, declared, sourceIp },
              '[F6] webhook body Content-Length invalid or exceeds cap — rejected before read',
            );
            span.setAttribute('f6.outcome', 'oversized_pre_check');
            return bodyOversizedResponse();
          }
        }

        // --- Step 3: Read raw body BEFORE any parse ----------------------
        // Wrap in try/catch — `request.text()` can throw on client
        // disconnect, chunked-encoding reset, or Vercel body-decode
        // failure. Without this, the route falls through to Next.js's
        // default 5xx with NO log/metric/audit and Zapier retries blind.
        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch (e) {
          eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'malformed');
          logger.error(
            {
              event: 'f6_webhook_body_read_failed',
              tenantSlug,
              errName: e instanceof Error ? e.constructor.name : 'unknown',
              sourceIp,
            },
            '[F6] webhook body read failed — returning 400',
          );
          span.setAttribute('f6.outcome', 'body_read_failed');
          return badRequestResponse('Webhook body read failed.');
        }

        // Post-read realised-size cap — catches attackers that omit
        // Content-Length or send chunked encoding that races past the
        // pre-check.
        if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
          eventcreateMetrics.bodyOversizedTotal(tenantSlug);
          logger.warn(
            {
              event: 'f6_webhook_body_oversized',
              tenantSlug,
              realised: rawBody.length,
              sourceIp,
            },
            '[F6] webhook body realised-size exceeds cap — rejected post-read',
          );
          span.setAttribute('f6.outcome', 'oversized_post_read');
          return bodyOversizedResponse();
        }

        // --- Step 4: Rate limit ------------------------------------------
        const rl = await ratelimitCheck(tenantSlug);
        if (!rl.success) {
          const retryAfter = retryAfterSecondsFromRl(rl);
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'rate_limited',
          );
          logger.warn(
            { event: 'f6_webhook_rate_limit_exceeded', tenantSlug, retryAfter, sourceIp },
            '[F6] webhook rate-limit exceeded',
          );
          span.setAttribute('f6.outcome', 'rate_limited');
          return NextResponse.json(
            {
              type: 'https://chamber-os.app/errors/rate-limited',
              title: 'Too many requests',
              status: 429,
              detail: `Tenant rate limit exceeded. Retry after ${retryAfter}s.`,
            },
            {
              status: 429,
              headers: { 'Retry-After': retryAfter.toString() },
            },
          );
        }

        // --- Step 5a: Tenant context build -------------------------------
        const tenantCtx = resolveTenantFromSlug(tenantSlug);
        if (!tenantCtx) {
          // Defensive — slug shape already passed step 0, so this only
          // fires if `asTenantContext` adds extra validation rules.
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'tenant_not_found',
          );
          logger.warn(
            { event: 'f6_webhook_invalid_tenant_slug', tenantSlug, sourceIp },
            '[F6] tenant context build failed (passed shape, failed context)',
          );
          span.setAttribute('f6.outcome', 'tenant_not_found');
          return notFoundResponse();
        }

        // --- Step 5b: Load webhook config --------------------------------
        let webhookConfig;
        try {
          webhookConfig = await loadTenantWebhookConfig(tenantCtx);
        } catch (e) {
          // Emit metric + standalone audit so dashboards & forensics
          // catch repeated config-load failures (RLS regression,
          // schema drift, Neon outage).
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'tenant_not_found',
          );
          logger.error(
            {
              event: 'f6_webhook_config_load_failed',
              tenantSlug,
              errName: e instanceof Error ? e.name : 'unknown',
            },
            '[F6] webhook config load failed',
          );
          await safeEmitStandalone(
            makeStandaloneAuditDeps(),
            {
              eventType: 'webhook_rolled_back',
              tenantId: asTenantId(tenantSlug),
              actorType: 'system',
              actorUserId: null,
              occurredAt: new Date(),
              summary: `webhook config load failed: ${e instanceof Error ? e.name : 'unknown'}`,
              payload: {
                severity: 'error',
                requestId,
                source: 'eventcreate',
                failureStage: 'unknown',
                errorMessage: 'config load failed',
                errorStack: null,
              },
            },
            {
              tenantSlug,
              logEvent: 'f6_webhook_config_load_audit_failed',
              logMsg: '[F6] config-load audit emission failed (suppressed — 500 still returned)',
            },
          );
          span.setAttribute('f6.outcome', 'config_load_failed');
          markSpanError(span, 'config_load_failed');
          return internalErrorResponse();
        }
        if (!webhookConfig) {
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'tenant_not_found',
          );
          span.setAttribute('f6.outcome', 'tenant_not_configured');
          return notFoundResponse();
        }

        // --- Step 6: Enabled check ---------------------------------------
        if (!webhookConfig.enabled) {
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'rejected_bad_sig',
            'ingest_disabled',
          );
          logger.warn(
            { event: 'f6_webhook_ingest_disabled', tenantSlug },
            '[F6] tenant ingest disabled',
          );
          span.setAttribute('f6.outcome', 'ingest_disabled');
          return ingestDisabledResponse();
        }

        // --- Step 7: Signature verify ------------------------------------
        const verifyOutcome = verifyWebhookSignature({
          rawBody,
          signatureHeader: request.headers.get('x-chamber-signature'),
          timestampHeader: request.headers.get('x-chamber-timestamp'),
          activeSecret: webhookConfig.activeSecret,
          graceSecret: webhookConfig.graceSecret,
          graceRotatedAt: webhookConfig.graceRotatedAt,
          now: new Date(),
          maxSkewSeconds: 300,
          verifier: cryptoWebhookSignatureVerifier,
        });

        if (!verifyOutcome.verified) {
          // Emit `webhook_signature_rejected` audit row in a separate
          // tx via the minimal `makeStandaloneAuditDeps()` factory.
          // Standalone tx + try/catch so audit failure does NOT crash
          // the 401 response.
          span.setAttribute('f6.signature_outcome', VERIFY_KIND_TO_OUTCOME[verifyOutcome.kind]);
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            VERIFY_KIND_TO_OUTCOME[verifyOutcome.kind],
            'unauthorized',
          );
          await safeEmitStandalone(
            makeStandaloneAuditDeps(),
            {
              eventType: 'webhook_signature_rejected',
              tenantId: asTenantId(tenantSlug),
              actorType: 'zapier_webhook',
              actorUserId: null,
              occurredAt: new Date(),
              summary: `webhook signature verification failed — verifyKind=${verifyOutcome.kind}`,
              payload: {
                severity: 'warn',
                requestId: rawRequestId.length > 0 ? rawRequestId : null,
                sourceIp,
                signatureLastFour:
                  request.headers.get('x-chamber-signature')?.slice(-4) ?? null,
                timestampSkewSeconds: verifyOutcome.skewSeconds,
                bodyLengthBytes: rawBody.length,
              },
            },
            {
              tenantSlug,
              logEvent: 'f6_webhook_sig_reject_audit_failed',
              logMsg: '[F6] signature-reject audit emission failed (suppressed — 401 still returned)',
            },
          );
          logger.warn(
            {
              event: 'f6_webhook_signature_verification_failed',
              tenantSlug,
              sourceIp,
              verifyKind: verifyOutcome.kind,
              // Distinguish genuine ID from `NO_REQUEST_ID` sentinel so
              // forensic queries can filter on "header was absent".
              requestId: rawRequestId.length > 0 ? rawRequestId : null,
            },
            '[F6] webhook signature verification failed',
          );
          span.setAttribute('f6.outcome', 'signature_rejected');
          return genericUnauthorized();
        }

        // --- Step 8: Parse JSON body ------------------------------------
        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(rawBody);
        } catch (e) {
          // V8's JSON.parse error message can include a snippet of
          // the malformed body which may carry PII. Log only the error
          // NAME + byte length — never the message.
          eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'malformed');
          logger.warn(
            {
              event: 'f6_webhook_invalid_json',
              tenantSlug,
              errName: e instanceof Error ? e.name : 'unknown',
              bodyBytes: rawBody.length,
            },
            '[F6] webhook body is not valid JSON',
          );
          span.setAttribute('f6.outcome', 'malformed_json');
          return NextResponse.json(
            {
              type: 'https://chamber-os.app/errors/malformed-webhook',
              title: 'Webhook payload validation failed',
              status: 400,
              errors: [{ path: '<root>', message: 'invalid JSON' }],
            },
            { status: 400 },
          );
        }

        // --- Step 9: Dispatch to ingest use-case ------------------------
        const deps = makeIngestWebhookAttendeeDeps();
        const result = await ingestWebhookAttendee(
          {
            tenantId: tenantSlug,
            requestId,
            source: 'eventcreate_webhook',
            rawPayload: parsedPayload,
            sourceIp,
            graceSecretUsed: verifyOutcome.usedGraceSecret,
          },
          deps,
        );

        // --- Step 10: Map Result → HTTP + emit latency histogram --------
        if (result.ok) {
          const processingOutcome = MATCH_TYPE_TO_PROCESSING_OUTCOME[result.value.matched];
          eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', processingOutcome);
          eventcreateMetrics.ingestLatencyMs(tenantSlug, result.value.ingestLatencyMs);
          span.setAttribute('f6.outcome', 'success');
          span.setAttribute('f6.match_type', result.value.matched);
          span.setAttribute('f6.ingest_latency_ms', result.value.ingestLatencyMs);
          return NextResponse.json({
            ok: true,
            matched: result.value.matched,
            matchedMemberId: result.value.matchedMemberId,
            eventCreated: result.value.eventCreated,
            registrationId: result.value.registrationId,
            quotaEffect: result.value.quotaEffect,
          });
        }

        // Emit latency for error paths too — even rolled-back deliveries
        // count against the SC-003 SLO. Use the use-case's internal
        // `ingestLatencyMs` when available (rolled_back path) so the
        // histogram compares apples-to-apples with the success path's
        // use-case-internal measurement. Other error kinds fall back
        // to route wall-clock latency.
        const errorLatencyMs =
          result.error.kind === 'rolled_back'
            ? result.error.ingestLatencyMs
            : Date.now() - startedAtMs;
        eventcreateMetrics.ingestLatencyMs(tenantSlug, errorLatencyMs);

        switch (result.error.kind) {
          case 'malformed_rejected':
            eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'malformed');
            span.setAttribute('f6.outcome', 'malformed_rejected');
            return NextResponse.json(
              {
                type: 'https://chamber-os.app/errors/malformed-webhook',
                title: 'Webhook payload validation failed',
                status: 400,
                errors: result.error.errors,
              },
              { status: 400 },
            );
          case 'duplicate_request_id':
            eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'duplicate');
            span.setAttribute('f6.outcome', 'duplicate_request_id');
            return NextResponse.json(
              {
                type: 'https://chamber-os.app/errors/duplicate-webhook',
                title: 'Duplicate webhook delivery',
                status: 409,
                detail: 'Request ID was already processed.',
                requestId,
              },
              { status: 409 },
            );
          case 'tenant_ingest_disabled':
            eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'ingest_disabled');
            span.setAttribute('f6.outcome', 'tenant_ingest_disabled');
            return ingestDisabledResponse();
          case 'rolled_back':
            // Audit `webhook_rolled_back` already emitted via dual-write
            // fallback in the use-case (or pino.fatal + last-ditch
            // stderr if the fallback also failed). Return generic
            // 500 — don't leak the failure stage to the caller.
            eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'rolled_back');
            logger.error(
              {
                event: 'f6_webhook_ingest_rolled_back',
                tenantSlug,
                requestId: rawRequestId.length > 0 ? rawRequestId : null,
                failureStage: result.error.failureStage,
                auditFallbackFailed: result.error.auditFallbackFailed,
              },
              result.error.auditFallbackFailed
                ? '[F6] webhook ingest rolled back AND audit fallback failed — see pino.fatal + last-ditch stderr lines'
                : '[F6] webhook ingest rolled back',
            );
            span.setAttribute('f6.outcome', 'rolled_back');
            span.setAttribute('f6.failure_stage', result.error.failureStage);
            markSpanError(span, `rolled_back:${result.error.failureStage}`);
            return NextResponse.json(
              {
                type: 'https://chamber-os.app/errors/internal-error',
                title: 'Internal error during webhook processing',
                status: 500,
                detail: 'Delivery was rolled back. Zapier will retry.',
              },
              { status: 500 },
            );
          default: {
            // Exhaustiveness assert. If a future phase adds a new
            // `IngestError.kind`, this `never`-assignment forces a TS
            // compile error — preventing the route from silently
            // falling off the function and returning an empty 200
            // (which Zapier would interpret as success and never
            // retry → silent data loss).
            const _exhaustive: never = result.error;
            // Redact: `_exhaustive` carries the full IngestError object
            // which may include errorMessage/errorStack. Log only the
            // discriminant `kind` to keep the forensic surface bounded.
            const unhandledKind = (_exhaustive as { kind?: string })?.kind ?? 'unknown';
            logger.fatal(
              { unhandledErrorKind: unhandledKind, tenantSlug },
              '[F6] unhandled IngestError kind — code path missing in route switch',
            );
            span.setAttribute('f6.outcome', 'unhandled_error_kind');
            markSpanError(span, `unhandled_error_kind:${unhandledKind}`);
            return internalErrorResponse();
          }
        }
      } catch (e) {
        // Last-resort catch — span needs to be ended with error status
        // even if something genuinely unexpected throws past every
        // defensive layer above.
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : String(e),
        });
        if (e instanceof Error) span.recordException(e);
        logger.fatal(
          {
            event: 'f6_webhook_uncaught_exception',
            tenantSlug,
            errName: e instanceof Error ? e.name : 'unknown',
          },
          '[F6] uncaught exception in webhook route handler',
        );
        return internalErrorResponse();
      } finally {
        span.end();
      }
    },
  );
}
