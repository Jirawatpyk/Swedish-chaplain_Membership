/**
 * T052 — POST /api/webhooks/eventcreate/v1/[tenantSlug] (F6 receiver).
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/webhook-eventcreate-api.md
 *   - FR-001..FR-013, FR-037
 *
 * Pipeline (owns steps 1–8; `ingestWebhookAttendee` use-case starts at
 * step 9):
 *   1. Content-Type check → 415 on non-JSON
 *   2. Raw body read (HMAC needs unparsed bytes)
 *   3. Rate-limit check (60 req/min per tenant, FR-005) → 429 + Retry-After
 *   4. Tenant slug resolve → 404 on invalid shape
 *   5. Load tenant webhook config → 404 if missing
 *   6. Enabled check → 503 + Retry-After: 3600 if disabled (FR-033)
 *   7. Signature verify → 401 generic body on any failure (no oracle)
 *   8. JSON parse → 400 on malformed payload
 *   9. Dispatch to `ingestWebhookAttendee` strict-transactional use-case
 *  10. Map result to HTTP:
 *      - ok → 200 with matched + registrationId
 *      - malformed_rejected → 400 with field errors
 *      - duplicate_request_id → 409
 *      - tenant_ingest_disabled → 503 + Retry-After: 3600
 *      - rolled_back → 500 (audit already emitted via dual-write fallback)
 *
 * Runtime: Node.js (NOT Edge) — needs raw body for HMAC verify + full
 * Node `crypto.timingSafeEqual` + Drizzle pool access.
 *
 * Security:
 *   - All 401 paths return identical generic body (no signature oracle).
 *   - Discriminator captured in audit log only (forensic use).
 *   - Forbidden in logs: webhook secrets, signature header value,
 *     attendee_email (pino redact list T002).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { asTenantId } from '@/modules/members';
import {
  verifyWebhookSignature,
  cryptoWebhookSignatureVerifier,
  ingestWebhookAttendee,
} from '@/modules/events';
import {
  makeIngestWebhookAttendeeDeps,
  ratelimitCheck,
  loadTenantWebhookConfig,
  resolveTenantFromSlug,
} from '@/lib/events-webhook-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

/**
 * Issue C-FULL-1 (full-scope review 2026-05-12) — body-size DoS guard.
 * Matches F5 stripe + F7 resend-broadcasts pattern. An unauthenticated
 * attacker POSTing a multi-MB body would exhaust Vercel Fluid Compute
 * memory BEFORE rate-limit (step 3) fires. 64 KiB chosen to match the
 * F5 cap; Zapier-style payloads are ~1 KB typical.
 */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024; // 64 KiB

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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Response helpers — keep the body shapes pinned to
// contracts/webhook-eventcreate-api.md.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ tenantSlug: string }> },
) {
  const { tenantSlug } = await ctx.params;
  const requestId = request.headers.get('x-request-id') ?? '';
  const sourceIp =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';

  // --- Step 1: Content-Type check ----------------------------------------
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'unsupported_media_type');
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

  // --- Step 1.5: Body-size pre-check (Issue C-FULL-1) -------------------
  // Reject oversized bodies BEFORE reading the body to memory + BEFORE
  // rate-limit (step 3). An attacker who can POST to the public URL
  // could otherwise exhaust Vercel Fluid Compute memory; the rate-limit
  // budget is per-tenant per-minute, so without this guard a single
  // attacker can spend their full minute pushing one giant request.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
      eventcreateMetrics.bodyOversizedTotal(tenantSlug);
      logger.warn(
        { event: 'f6_webhook_body_oversized', tenantSlug, declared, sourceIp },
        '[F6] webhook body Content-Length exceeds cap — rejected before read',
      );
      return bodyOversizedResponse();
    }
  }

  // --- Step 2: Read raw body BEFORE any parse ---------------------------
  const rawBody = await request.text();
  // Post-read realised-size cap — catches attackers that omit
  // Content-Length or send chunked encoding that races past the
  // pre-check.
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    eventcreateMetrics.bodyOversizedTotal(tenantSlug);
    logger.warn(
      { event: 'f6_webhook_body_oversized', tenantSlug, realised: rawBody.length, sourceIp },
      '[F6] webhook body realised-size exceeds cap — rejected post-read',
    );
    return bodyOversizedResponse();
  }

  // --- Step 3: Rate limit (FR-005 60 req/min per tenant) ----------------
  const rl = await ratelimitCheck(tenantSlug);
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl(rl);
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'rate_limited');
    logger.warn(
      { event: 'f6_webhook_rate_limit_exceeded', tenantSlug, retryAfter, sourceIp },
      '[F6] webhook rate-limit exceeded',
    );
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

  // --- Step 4: Tenant slug → context ------------------------------------
  const tenantCtx = resolveTenantFromSlug(tenantSlug);
  if (!tenantCtx) {
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'tenant_not_found');
    logger.warn(
      { event: 'f6_webhook_invalid_tenant_slug', tenantSlug, sourceIp },
      '[F6] invalid tenant slug shape',
    );
    return notFoundResponse();
  }

  // --- Step 5: Load webhook config --------------------------------------
  let webhookConfig;
  try {
    webhookConfig = await loadTenantWebhookConfig(tenantCtx);
  } catch (e) {
    logger.error(
      {
        event: 'f6_webhook_config_load_failed',
        tenantSlug,
        errName: e instanceof Error ? e.name : 'unknown',
      },
      '[F6] webhook config load failed',
    );
    return NextResponse.json(
      {
        type: 'https://chamber-os.app/errors/internal-error',
        title: 'Internal error',
        status: 500,
      },
      { status: 500 },
    );
  }
  if (!webhookConfig) {
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'tenant_not_found');
    return notFoundResponse();
  }

  // --- Step 6: Enabled check (FR-033) -----------------------------------
  if (!webhookConfig.enabled) {
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'rejected_bad_sig', 'ingest_disabled');
    logger.warn(
      { event: 'f6_webhook_ingest_disabled', tenantSlug },
      '[F6] tenant ingest disabled',
    );
    return ingestDisabledResponse();
  }

  // --- Step 7: Signature verify (FR-002 + FR-003 + FR-008) --------------
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
    // Per Issue C-FULL-2 + I5 (full-scope review 2026-05-12): emit
    // `webhook_signature_rejected` audit row in a SEPARATE tx via the
    // dedicated `emitStandalone` method so the correct event type is
    // recorded (previous code mis-emitted as `webhook_rolled_back`).
    // Durable 5-year forensic trail enables R10 credential-stuffing
    // alert; standalone tx + try/catch so audit failure does NOT crash
    // the 401 response.
    const verifyKindToSignatureOutcome: Record<typeof verifyOutcome.kind, Parameters<typeof eventcreateMetrics.webhookReceiptsTotal>[1]> = {
      missing_signature_header: 'rejected_missing_header',
      missing_timestamp_header: 'rejected_missing_header',
      malformed_timestamp: 'rejected_malformed_timestamp',
      timestamp_skew_exceeded: 'rejected_timestamp_skew',
      signature_mismatch: 'rejected_bad_sig',
    };
    eventcreateMetrics.webhookReceiptsTotal(
      tenantSlug,
      verifyKindToSignatureOutcome[verifyOutcome.kind],
      'unauthorized',
    );
    try {
      const auditDeps = makeIngestWebhookAttendeeDeps();
      await auditDeps.emitStandalone({
        eventType: 'webhook_signature_rejected',
        tenantId: asTenantId(tenantSlug),
        actorType: 'zapier_webhook',
        actorUserId: null,
        occurredAt: new Date(),
        summary: `webhook signature verification failed — verifyKind=${verifyOutcome.kind}`,
        payload: {
          severity: 'warn',
          requestId: requestId || null,
          sourceIp,
          signatureLastFour: request.headers.get('x-chamber-signature')?.slice(-4) ?? null,
          timestampSkewSeconds: verifyOutcome.skewSeconds,
          bodyLengthBytes: rawBody.length,
        },
      });
    } catch (auditErr) {
      logger.error(
        {
          event: 'f6_webhook_sig_reject_audit_failed',
          tenantSlug,
          errName: auditErr instanceof Error ? auditErr.name : 'unknown',
        },
        '[F6] signature-reject audit emission failed (suppressed — 401 still returned)',
      );
    }
    logger.warn(
      {
        event: 'f6_webhook_signature_verification_failed',
        tenantSlug,
        sourceIp,
        verifyKind: verifyOutcome.kind,
        requestId: requestId || null,
      },
      '[F6] webhook signature verification failed',
    );
    return genericUnauthorized();
  }

  // --- Step 8: Parse JSON body -----------------------------------------
  let parsedPayload: unknown;
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch (e) {
    // Issue S1 (review 2026-05-12): V8's JSON.parse error message
    // includes a snippet of the malformed body which could carry PII.
    // Log only the error NAME + byte length — not the message.
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

  // --- Step 9: Dispatch to ingest use-case -----------------------------
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

  // --- Step 10: Map Result → HTTP ---------------------------------------
  if (result.ok) {
    // Map Domain MatchType → metric processing-outcome label. The
    // metric's union mirrors the ProcessingOutcome value-object
    // (`matched_member_*` prefix) for dashboard readability; MatchType
    // omits the prefix on member match variants.
    const processingOutcome = (
      result.value.matched === 'member_contact'
        ? 'matched_member_contact'
        : result.value.matched === 'member_domain'
          ? 'matched_member_domain'
          : result.value.matched === 'member_fuzzy'
            ? 'matched_member_fuzzy'
            : result.value.matched
    ) as Parameters<typeof eventcreateMetrics.webhookReceiptsTotal>[2];
    eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', processingOutcome);
    return NextResponse.json({
      ok: true,
      matched: result.value.matched,
      matchedMemberId: result.value.matchedMemberId,
      eventCreated: result.value.eventCreated,
      registrationId: result.value.registrationId,
      quotaEffect: result.value.quotaEffect,
    });
  }

  switch (result.error.kind) {
    case 'malformed_rejected':
      eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'malformed');
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
      return ingestDisabledResponse();
    case 'rolled_back':
      // Audit `webhook_rolled_back` already emitted via dual-write
      // fallback in the use-case. Return generic 500 — don't leak the
      // failure stage to the caller.
      eventcreateMetrics.webhookReceiptsTotal(tenantSlug, 'verified', 'rolled_back');
      logger.error(
        {
          event: 'f6_webhook_ingest_rolled_back',
          tenantSlug,
          requestId: requestId || null,
          failureStage: result.error.failureStage,
        },
        '[F6] webhook ingest rolled back',
      );
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
      // Issue C2 (review 2026-05-12): exhaustiveness assert. If a future
      // phase adds a new `IngestError.kind`, this `never`-assignment
      // forces a TS compile error — preventing the route from silently
      // falling off the function and returning an empty 200 (which
      // Zapier would interpret as success and never retry → silent data
      // loss).
      const _exhaustive: never = result.error;
      logger.fatal(
        { unhandledErrorKind: _exhaustive, tenantSlug },
        '[F6] unhandled IngestError kind — code path missing in route switch',
      );
      return NextResponse.json(
        {
          type: 'https://chamber-os.app/errors/internal-error',
          title: 'Internal error',
          status: 500,
        },
        { status: 500 },
      );
    }
  }
}
