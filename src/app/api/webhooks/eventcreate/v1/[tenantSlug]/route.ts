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
import { safeEmitStandalone } from '@/lib/events-safe-emit-standalone';
import { problemResponse } from '@/lib/http/problem-response';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
import { TENANT_SLUG_PATTERN } from '@/modules/tenants';
import {
  verifyWebhookSignature,
  cryptoWebhookSignatureVerifier,
  ingestWebhookAttendee,
  MATCH_TYPE_TO_PROCESSING_OUTCOME,
  asRequestId,
  tryRequestId,
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
  return problemResponse(
    413,
    'payload-too-large',
    'Payload too large',
    `Webhook body exceeds the ${MAX_WEBHOOK_BODY_BYTES} byte limit.`,
  );
}

function genericUnauthorized(): NextResponse {
  return problemResponse(
    401,
    'webhook-unauthorized',
    'Webhook authentication failed',
    'Signature or timestamp validation failed. See audit log for outcome.',
  );
}

function notFoundResponse(): NextResponse {
  return problemResponse(404, 'not-found', 'Not found');
}

function ingestDisabledResponse(): NextResponse {
  return problemResponse(
    503,
    'ingest-disabled',
    'Ingest temporarily disabled',
    'Tenant ingest is currently paused. Retry later.',
    { headers: { 'Retry-After': '3600' } },
  );
}

function badRequestResponse(detail: string): NextResponse {
  return problemResponse(400, 'malformed-webhook', 'Bad request', detail);
}

function internalErrorResponse(): NextResponse {
  return problemResponse(500, 'internal-error', 'Internal error');
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

// R7-F staff-review fix (2026-05-13): `safeEmitStandalone` extracted
// to `@/lib/events-safe-emit-standalone` so admin route handlers can
// reuse the same idiom (round-6 B7 originally inlined a bare try/
// catch; round-7 R2-F refactors it). The shared helper internally
// applies `redactStack` to the caught error's stack before logging
// (preserving the round-6 W2 PII protection — container paths +
// node_modules + webpack-internal:/// scrubbed). Callers do not need
// to re-redact.

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

  // R6-W1 staff-review fix (2026-05-13): cap the header at 200 chars
  // before any further use. Both `audit_log.request_id` and
  // `eventcreate_idempotency_receipts.request_id` are unbounded text
  // columns; without this cap a sustained Upstash-fail-open attack
  // window could push 64-KiB request IDs into 600k+ audit rows over
  // the 7-day idempotency window. The 200-char cap matches the eventId
  // cap set by Phase 4 round-5 R002.
  const rawRequestId =
    (request.headers.get('x-request-id')?.trim() ?? '').slice(0, 200);
  const requestId = rawRequestId.length > 0 ? rawRequestId : NO_REQUEST_ID;
  if (rawRequestId.length === 0) {
    // Round 3 M-err-2 (2026-05-13) — proactive warn when an inbound
    // webhook arrives without `X-Request-ID`. `audit_log.request_id`
    // is the primary forensic correlation key for the entire F6
    // webhook surface; without a proactive signal SREs only discover
    // a Zapier config drift after an incident triage query groups by
    // `request_id = 'no-request-id'`.
    logger.warn(
      {
        event: 'f6_webhook_missing_request_id',
        tenantSlug,
      },
      '[F6] inbound webhook missing X-Request-ID header — sentinel substituted',
    );
  }
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
            'rejected_pre_auth',
            'unsupported_media_type',
          );
          span.setAttribute('f6.outcome', 'unsupported_media_type');
          return problemResponse(
            415,
            'unsupported-media-type',
            'Unsupported media type',
            'Expected Content-Type: application/json',
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
          eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_pre_auth', 'malformed');
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
          return problemResponse(
            429,
            'rate-limited',
            'Too many requests',
            `Tenant rate limit exceeded. Retry after ${retryAfter}s.`,
            { headers: { 'Retry-After': retryAfter.toString() } },
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
          // R6-W5 staff-review fix (2026-05-13): switch from
          // `webhook_rolled_back` (semantically: primary tx began then
          // was rolled back) to the dedicated
          // `webhook_ingest_precondition_failed` event so SRE filters
          // on `webhook_rolled_back` don't see spurious config-load
          // blips. The two are queryable independently in audit_log.
          await safeEmitStandalone(
            makeStandaloneAuditDeps(),
            {
              eventType: 'webhook_ingest_precondition_failed',
              tenantId: asTenantId(tenantSlug),
              actorType: 'system',
              actorUserId: null,
              occurredAt: new Date(),
              summary: `webhook config load failed: ${e instanceof Error ? e.name : 'unknown'}`,
              payload: {
                severity: 'error',
                requestId: rawRequestId.length > 0 ? rawRequestId : null,
                sourceIp,
                stage: 'config_load_failed',
                errorName: e instanceof Error ? e.name : 'unknown',
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
        // The verifier port input takes the loose pair (its own shape,
        // separate from the aggregate type). Decompose the aggregate's
        // GraceState union back to nullable pair at the boundary.
        const verifyOutcome = verifyWebhookSignature({
          rawBody,
          signatureHeader: request.headers.get('x-chamber-signature'),
          timestampHeader: request.headers.get('x-chamber-timestamp'),
          activeSecret: webhookConfig.activeSecret,
          graceSecret: webhookConfig.grace.active ? webhookConfig.grace.secret : null,
          graceRotatedAt: webhookConfig.grace.active ? webhookConfig.grace.rotatedAt : null,
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

        // --- Step 7.5: webhook_secret_grace_used audit (FR-008) --------
        // Per spec FR-008 + Domain doc `tenant-webhook-config.ts:14-15`:
        // when signature verification succeeded on the deprecated
        // grace key (the previous active secret retained for the 24h
        // post-rotation window), emit a SEPARATE
        // `webhook_secret_grace_used` audit row IN ADDITION to the
        // downstream success/duplicate/error audit so SREs can
        // distinguish "active secret used" from "grace secret used"
        // without joining on `payload.graceSecretUsed`. The audit
        // event type was declared in audit-port.ts at Phase 2 but
        // never emitted until the round-2 verify-fix (H1, 2026-05-13)
        // wired this site.
        //
        // Computed `graceSecretAgeHours` is bounded by `[0, 24]` —
        // verifier already rejected anything older. Floor to integer
        // hours so the audit payload is queryable without float-edge
        // surprises in SRE dashboards.
        if (
          verifyOutcome.usedGraceSecret &&
          webhookConfig.grace.active
        ) {
          const graceAgeMs = Date.now() - webhookConfig.grace.rotatedAt.getTime();
          const graceSecretAgeHours = Math.max(
            0,
            Math.floor(graceAgeMs / (60 * 60 * 1000)),
          );
          await safeEmitStandalone(
            makeStandaloneAuditDeps(),
            {
              eventType: 'webhook_secret_grace_used',
              tenantId: asTenantId(tenantSlug),
              actorType: 'zapier_webhook',
              actorUserId: null,
              occurredAt: new Date(),
              summary: `webhook accepted on grace secret (age ${graceSecretAgeHours}h, last4=${webhookConfig.grace.secret.slice(-4)})`,
              payload: {
                severity: 'warn',
                requestId,
                graceSecretAgeHours,
              },
            },
            {
              tenantSlug,
              logEvent: 'f6_webhook_grace_used_audit_failed',
              logMsg: '[F6] webhook_secret_grace_used standalone audit FAILED — ingest proceeds (downstream webhook_receipt_verified.payload.graceSecretUsed=true still preserves the grace-key signal; SRE dashboard primary source is the receipt-verified event, not this standalone event)',
            },
          );
          span.setAttribute('f6.grace_secret_used', true);
          span.setAttribute('f6.grace_secret_age_hours', graceSecretAgeHours);
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
          return problemResponse(
            400,
            'malformed-webhook',
            'Webhook payload validation failed',
            undefined,
            { extras: { errors: [{ path: '<root>', message: 'invalid JSON' }] } },
          );
        }

        // --- Step 8.5: Test-webhook sentinel short-circuit (Phase 5 T074) --
        // Per `contracts/admin-integration-eventcreate-api.md` § POST
        // test-webhook (round-2 P8): if the synthetic payload uses the
        // `__test_webhook__` sentinel external IDs, skip the full ACID
        // unit so no event/registration/idempotency rows land. Emit
        // `webhook_test_invoked` standalone audit with
        // `processingOutcome='short_circuited_test'` so the admin's
        // recent-deliveries panel surfaces the test.
        //
        // Defensive read: we don't trust the zod-unvalidated shape, so
        // a runtime `typeof` guard precedes the access. False match
        // (random payload that happens to set externalId to the
        // sentinel) is statistically negligible — the value is
        // double-underscored + admin-actor-only.
        const candidate = parsedPayload as {
          event?: { externalId?: unknown };
          attendee?: { externalId?: unknown };
        };
        const eventExternalId =
          typeof candidate.event === 'object' &&
          candidate.event !== null &&
          typeof candidate.event.externalId === 'string'
            ? candidate.event.externalId
            : '';
        const attendeeExternalId =
          typeof candidate.attendee === 'object' &&
          candidate.attendee !== null &&
          typeof candidate.attendee.externalId === 'string'
            ? candidate.attendee.externalId
            : '';
        // R6.W / Round 5 staff-review R008 (T-elevation) closure —
        // require `chamberTestMetadata` envelope (HMAC-signed by the
        // admin route's run-test-webhook use-case) to be PRESENT before
        // short-circuiting the ACID pipeline. Pre-fix accepted any
        // payload whose externalIds matched the sentinel pattern even
        // if `chamberTestMetadata` was null/malformed — a malicious
        // tenant insider with EventCreate config access could craft a
        // real-attendee payload using event externalId
        // `__test_webhook__` to bypass FR-013/015/016 invariants while
        // still emitting a valid `webhook_test_invoked` audit. The
        // chamberTestMetadata + its HMAC coverage make the test-webhook
        // path provably distinguishable from production ingest.
        const earlyChamberTestMetadata =
          typeof candidate === 'object' &&
          candidate !== null &&
          'chamberTestMetadata' in candidate &&
          typeof (candidate as Record<string, unknown>)['chamberTestMetadata'] ===
            'object' &&
          (candidate as Record<string, unknown>)['chamberTestMetadata'] !== null;
        if (
          eventExternalId === '__test_webhook__' &&
          attendeeExternalId.startsWith('__test_webhook__-') &&
          earlyChamberTestMetadata
        ) {
          const shortCircuitLatencyMs = Date.now() - startedAtMs;
          eventcreateMetrics.webhookReceiptsTotal(
            tenantSlug,
            'verified',
            'short_circuited_test',
          );
          eventcreateMetrics.ingestLatencyMs(tenantSlug, shortCircuitLatencyMs);
          // System sentinel actor — the receiver-side audit doesn't know
          // the admin who clicked "Test webhook" (the run-test-webhook
          // use-case POSTs the synthetic payload without propagating
          // session identity, intentionally — actor attribution lives
          // in the admin route-handler logs). Use the F6 system sentinel
          // prefix per pino-audit-port convention.
          const SYSTEM_ACTOR = asUserId('system:f6-test-webhook');

          // Phase 5 review-fix S-05 (2026-05-13) — extract the admin
          // originator metadata that the admin route's run-test-webhook
          // use-case embedded in the synthetic payload. The fields
          // pass through `chamberTestMetadata` and are HMAC-signed (the
          // signature is already verified at this point), so the values
          // are tamper-resistant. Drift detection: if a future code
          // path produces a sentinel payload without this metadata, the
          // audit row records `null` and an SRE filter on
          // `dispatchedByActorRole IS NULL` surfaces the gap.
          const chamberTestMetadata =
            typeof candidate === 'object' &&
            candidate !== null &&
            'chamberTestMetadata' in candidate &&
            typeof candidate.chamberTestMetadata === 'object' &&
            candidate.chamberTestMetadata !== null
              ? candidate.chamberTestMetadata
              : null;
          const dispatchedByActorUserId =
            chamberTestMetadata !== null &&
            'dispatchedByActorUserId' in chamberTestMetadata &&
            typeof chamberTestMetadata.dispatchedByActorUserId === 'string' &&
            chamberTestMetadata.dispatchedByActorUserId.length > 0
              ? asUserId(chamberTestMetadata.dispatchedByActorUserId)
              : null;
          const dispatchedByActorRole =
            chamberTestMetadata !== null &&
            'dispatchedByActorRole' in chamberTestMetadata &&
            chamberTestMetadata.dispatchedByActorRole === 'admin'
              ? ('admin' as const)
              : null;

          await safeEmitStandalone(
            makeStandaloneAuditDeps(),
            {
              eventType: 'webhook_test_invoked',
              tenantId: asTenantId(tenantSlug),
              actorType: 'system',
              actorUserId: SYSTEM_ACTOR,
              occurredAt: new Date(),
              summary: `test webhook short-circuited (sentinel external IDs) — latency ${shortCircuitLatencyMs}ms`,
              payload: {
                severity: 'info',
                actorUserId: SYSTEM_ACTOR,
                // Round-6 verify-fix 2026-05-13 (type-design C2) —
                // field renamed from `testRequestId` → `requestId`
                // to share the same convention as
                // `webhook_receipt_verified` / `webhook_secret_grace_used`
                // / `webhook_signature_rejected`. Brand at boundary
                // (string-shape) keeps the audit payload's `RequestId`
                // invariant compile-checked.
                //
                // Round 2 R-H1 fix (2026-05-13) — `asRequestId` THROWS
                // on non-printable-ASCII or `length > 256`. Inbound
                // `x-request-id` is user-controlled; defaults to the
                // `NO_REQUEST_ID` sentinel via `tryRequestId` to avoid
                // a 500 fall-through that would mask the test-webhook
                // short-circuit's 200 response. Attacker needs valid
                // HMAC (low practical impact) but defence-in-depth.
                requestId:
                  tryRequestId(requestId) ?? asRequestId(NO_REQUEST_ID),
                durationMs: shortCircuitLatencyMs,
                // Phase 5 review-fix S-05 — originator attribution.
                dispatchedByActorUserId,
                dispatchedByActorRole,
              },
            },
            {
              tenantSlug,
              logEvent: 'f6_webhook_test_invoked_audit_failed',
              logMsg: '[F6] test-webhook short-circuit audit emission failed (suppressed — 200 still returned)',
            },
          );
          span.setAttribute('f6.outcome', 'short_circuited_test');
          return NextResponse.json({
            ok: true,
            matched: 'short_circuited_test',
            matchedMemberId: null,
            eventCreated: false,
            registrationId: null,
            quotaEffect: null,
            processingOutcome: 'short_circuited_test',
          });
        }

        // --- Step 8.6: Detect sentinel-pattern fall-through -------------
        // R7.W / Staff R2 R033 — when the externalIds match the test-
        // sentinel pattern BUT `chamberTestMetadata` is missing /
        // malformed, the request reaches here despite the R008 short-
        // circuit not firing. The HMAC was valid (otherwise we'd have
        // rejected at Step 7), so this is an authenticated edge case:
        // either Zapier misconfiguration (literal `__test_webhook__`
        // as externalId) or insider probing for sentinel-pattern
        // detectability. Emit a structured warn (log-only signal — no
        // metric counter; SREs search via pino log streams on the
        // `f6_sentinel_pattern_without_metadata` event key). R8.W /
        // Staff R3 R048 — comment honestly reflects the absence of a
        // counter; the bypass-attempt rate is bounded by the per-tenant
        // 60/min Upstash rate-limit gate above, so log-stream alerting
        // on a single occurrence is sufficient. Do NOT fail the request
        // — the regular ingest pipeline handles the "real" registration
        // safely; this log surfaces the anomaly without breaking flow.
        if (
          eventExternalId === '__test_webhook__' &&
          attendeeExternalId.startsWith('__test_webhook__-')
        ) {
          // R8.S / Staff R3 R070 (Suggestion) — emission cadence is
          // bounded by the per-tenant 60 req/min Upstash rate-limit
          // gate (max 60 warn lines/min/tenant). A misconfigured Zap
          // that emits real attendees with sentinel externalIds could
          // produce sustained log spam at this ceiling. Future
          // improvement: log-rate-limit (e.g., log once + every 100th
          // occurrence per tenant per hour) once the cardinality of
          // legitimate test-mode patterns has been observed in prod.
          // Tracked as F6.2 backlog; non-blocking today.
          logger.warn(
            {
              event: 'f6_sentinel_pattern_without_metadata',
              tenantSlug,
              requestId,
              // R8.W / Staff R3 R051 — sourceIp added for forensic
              // correlation. Sibling security warns at L311/L334/L352/
              // L370/L399/L524/L541 all include sourceIp; this branch
              // (insider-probing detection) needs it too.
              sourceIp,
              eventExternalId,
              attendeeExternalIdPrefix: '__test_webhook__-',
              hasChamberTestMetadata: false,
            },
            '[F6] Sentinel externalId pattern detected without chamberTestMetadata — possible Zap misconfiguration or insider probing; proceeding with regular ingest',
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
            return problemResponse(
              400,
              'malformed-webhook',
              'Webhook payload validation failed',
              undefined,
              { extras: { errors: result.error.errors } },
            );
          case 'duplicate_request_id':
            eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'duplicate');
            span.setAttribute('f6.outcome', 'duplicate_request_id');
            return problemResponse(
              409,
              'duplicate-webhook',
              'Duplicate webhook delivery',
              'Request ID was already processed.',
              { extras: { requestId } },
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
            return problemResponse(
              500,
              'internal-error',
              'Internal error during webhook processing',
              'Delivery was rolled back. Zapier will retry.',
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
