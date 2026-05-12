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

  // --- Step 2: Read raw body BEFORE any parse ---------------------------
  const rawBody = await request.text();

  // --- Step 3: Rate limit (FR-005 60 req/min per tenant) ----------------
  const rl = await ratelimitCheck(tenantSlug);
  if (!rl.success) {
    const retryAfter = retryAfterSecondsFromRl(rl);
    logger.warn(
      { tenantSlug, retryAfter, sourceIp },
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
    logger.warn({ tenantSlug, sourceIp }, '[F6] invalid tenant slug shape');
    return notFoundResponse();
  }

  // --- Step 5: Load webhook config --------------------------------------
  let webhookConfig;
  try {
    webhookConfig = await loadTenantWebhookConfig(tenantCtx);
  } catch (e) {
    logger.error(
      { tenantSlug, err: e instanceof Error ? e.message : String(e) },
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
    return notFoundResponse();
  }

  // --- Step 6: Enabled check (FR-033) -----------------------------------
  if (!webhookConfig.enabled) {
    logger.warn({ tenantSlug }, '[F6] tenant ingest disabled');
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
    // Discriminator captured in log only (audit emission via use-case
    // happens on the success path; standalone rejection audits are
    // a Wave 3.3+ optimisation — current path logs but does not emit
    // a separate `webhook_signature_rejected` audit row).
    logger.warn(
      {
        tenantSlug,
        sourceIp,
        verifyKind: verifyOutcome.kind,
        requestIdMasked: requestId.slice(0, 8) || null,
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
    logger.warn(
      { tenantSlug, err: e instanceof Error ? e.message : String(e) },
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
      return ingestDisabledResponse();
    case 'rolled_back':
      // Audit `webhook_rolled_back` already emitted via dual-write
      // fallback in the use-case. Return generic 500 — don't leak the
      // failure stage to the caller.
      logger.error(
        {
          tenantSlug,
          requestIdMasked: requestId.slice(0, 8) || null,
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
  }
}
