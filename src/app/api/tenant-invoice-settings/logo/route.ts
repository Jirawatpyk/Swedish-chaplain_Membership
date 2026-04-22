/**
 * R7-B2 — POST /api/tenant-invoice-settings/logo (FR-034 / F4 US4 AS4).
 *
 * Dedicated logo-upload endpoint. Accepts multipart/form-data with a
 * single `file` field. Enforces at the `uploadTenantLogo` use-case:
 *
 *   - MIME ∈ {image/png, image/jpeg} (SVG explicitly rejected)
 *   - size ≤ 1 MB
 *   - dimensions 200 ≤ w ≤ 2000, 100 ≤ h ≤ 500
 *   - sharp re-encode to strip EXIF / metadata
 *
 * Returns `{ logo_blob_key }` on success — caller wires it through
 * `PATCH /api/tenant-invoice-settings { logo_blob_key }`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { uploadTenantLogo, makeUploadTenantLogoDeps } from '@/modules/invoicing';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { createHash } from 'node:crypto';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'tenant_invoice_settings',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // N5 — rate-limit. Logo upload kicks sharp decode + re-encode which
  // is CPU-expensive; 15 / min per (tenant, actor) is generous for
  // legitimate settings-form usage.
  const rl = await rateLimiter.check(
    `f4:settings:logo:${tenantCtx.slug}:${ctx.current.user.id}`,
    15,
    60,
  );
  if (!rl.success) {
    logger.warn(
      { requestId, tenantId: tenantCtx.slug, userId: ctx.current.user.id, reset: rl.reset },
      'POST /api/tenant-invoice-settings/logo rate-limited',
    );
    return NextResponse.json(
      { error: { code: 'rate_limited', retryAfterMs: rl.reset - Date.now() } },
      {
        status: 429,
        headers: { 'Retry-After': String(Math.ceil((rl.reset - Date.now()) / 1000)) },
      },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_multipart' } },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: 'missing_file_field' } },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // T092b — Idempotency-Key support. The header is OPTIONAL for logo
  // upload (unlike F2 mutating endpoints which require it) because
  // the UX is a single file-picker click; replay mostly matters when
  // a retry happens during a flaky upload. When the header is
  // present, same-key+same-bytes returns the ORIGINAL `logo_blob_key`
  // instead of creating a new Blob object, which avoids consuming
  // slots against the 50-logo-per-tenant cap.
  const tenantCtxKeyed = asTenantContext(tenantCtx.slug);
  const idempotencyParsed = parseIdempotencyKey(request.headers);
  const bodyHash =
    idempotencyParsed.ok
      ? hashRequestBody(
          {
            contentSha256: createHash('sha256').update(bytes).digest('hex'),
            mime: file.type,
            size: file.size,
          },
          'POST /api/tenant-invoice-settings/logo',
        )
      : null;

  if (idempotencyParsed.ok && bodyHash) {
    const classification = await classifyIdempotencyRequest(
      tenantCtxKeyed,
      idempotencyParsed.key,
      bodyHash,
    );
    if (classification.kind === 'replay') {
      return NextResponse.json(
        classification.previousResponse.body,
        { status: classification.previousResponse.status },
      );
    }
    if (classification.kind === 'conflict') {
      return NextResponse.json(
        { error: { code: 'idempotency_conflict' } },
        { status: 409 },
      );
    }
    await reserveIdempotencyRecord(tenantCtxKeyed, idempotencyParsed.key, bodyHash);
  }

  const result = await uploadTenantLogo(makeUploadTenantLogoDeps(), {
    tenantId: tenantCtx.slug,
    actorUserId: ctx.current.user.id,
    requestId,
    bytes,
    declaredMime: file.type,
    declaredSize: file.size,
  });

  if (!result.ok) {
    const errorCode = result.error.code;
    const status =
      errorCode === 'mime_rejected' || errorCode === 'dimensions_out_of_range'
        ? 415
        : errorCode === 'too_large'
          ? 413
          : errorCode === 'logo_history_cap_reached'
            ? 409
            : 400;
    logger.warn(
      { requestId, tenantSlug: tenantCtx.slug, err: result.error },
      'tenant logo upload rejected',
    );
    // F-01 fix — cache the 4xx response under the idempotency key so a
    // replay of the same key+body returns the SAME error verbatim
    // instead of the shared infra's null-response branch returning 409
    // conflict. Matches HTTP idempotency semantics: replay of a request
    // that validation-rejected yields the same rejection.
    const errorBody = { error: result.error };
    if (idempotencyParsed.ok && bodyHash) {
      await rememberIdempotentResponse(tenantCtxKeyed, idempotencyParsed.key, bodyHash, {
        status,
        body: errorBody,
      });
    }
    return NextResponse.json(errorBody, { status });
  }

  const body = { logo_blob_key: result.value.logoBlobKey };
  if (idempotencyParsed.ok && bodyHash) {
    await rememberIdempotentResponse(tenantCtxKeyed, idempotencyParsed.key, bodyHash, {
      status: 201,
      body,
    });
  }
  return NextResponse.json(body, { status: 201 });
}
