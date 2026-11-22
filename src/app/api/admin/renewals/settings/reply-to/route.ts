/**
 * PR B (#707 follow-up) — GET / PUT `/api/admin/renewals/settings/reply-to`.
 *
 * The renewal reminder Reply-To (`tenant_renewal_settings.reply_to_*`) for the
 * admin settings page. Same gate as the schedule editor
 * (`settings.renewal_schedules`: admin + super_admin; a manager gets 403 and
 * the `f8_role_violation_blocked` audit). PUT refuses under READ_ONLY_MODE
 * after the gate, before any write.
 *
 * Audit: `renewal_reply_to_updated` is emitted inside the use case, atomic
 * with the upsert, and only when a value changed. Its payload keeps the
 * address's domain, never the address.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { assertNever } from '@/lib/assert-never';
import {
  loadRenewalReplyTo,
  makeRenewalsDeps,
  updateRenewalReplyTo,
  REPLY_TO_DISPLAY_NAME_MAX,
  REPLY_TO_EMAIL_MAX,
} from '@/modules/renewals';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`). `pnpm check:f8-error-id` enforces
 * that every 500 here, and every error-level line inside a catch, carries it
 * with some suffix; the suffix names the verb (`.READ_…` / `.WRITE_…`).
 */
const ERROR_ID = 'F8.REPLY_TO';

// The use case trims and validates; the wire only bounds the size. A
// little slack over the limits lets surrounding spaces reach the trim.
const BodySchema = z
  .object({
    email: z.string().max(REPLY_TO_EMAIL_MAX + 64).nullable(),
    displayName: z.string().max(REPLY_TO_DISPLAY_NAME_MAX + 64).nullable(),
  })
  .strict();

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({ status: 503, code: 'feature_disabled', correlationId: randomUUID() });
  }
  const ctx = await requireRenewalAdminContext(request, 'read', 'settings.renewal_schedules', ERROR_ID);
  if ('response' in ctx) return ctx.response;

  try {
    const tenantCtx = resolveTenantFromRequest(request);
    const result = await loadRenewalReplyTo(makeRenewalsDeps(tenantCtx.slug), tenantCtx.slug);
    if (!result.ok) {
      logger.error(
        { errorId: `${ERROR_ID}.READ_SERVER_ERROR`, correlationId: ctx.correlationId },
        'admin.renewals.reply_to_read_server_error',
      );
      return errorResponse({ status: 500, code: 'server_error', correlationId: ctx.correlationId });
    }
    return successResponse(
      { email: result.value.email, displayName: result.value.displayName },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      { errorId: `${ERROR_ID}.READ_UNEXPECTED`, err: errKind(e), correlationId: ctx.correlationId },
      'admin.renewals.reply_to_read_unexpected',
    );
    return errorResponse({ status: 500, code: 'server_error', correlationId: ctx.correlationId });
  }
}

export async function PUT(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({ status: 503, code: 'feature_disabled', correlationId: randomUUID() });
  }
  const ctx = await requireRenewalAdminContext(request, 'write', 'settings.renewal_schedules', ERROR_ID);
  if ('response' in ctx) return ctx.response;

  // READ_ONLY_MODE: 503 after the gate, before any write (the member-changes
  // pattern). The proxy refuses too; this keeps the route honest on its own.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({ status: 400, code: 'invalid_body', correlationId: ctx.correlationId });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({ status: 400, code: 'invalid_body', correlationId: ctx.correlationId });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  try {
    const result = await updateRenewalReplyTo(makeRenewalsDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      actorUserId: ctx.current.user.id,
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the gate
      // above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_email':
        case 'display_name_without_email':
          return errorResponse({ status: 422, code: result.error.kind, correlationId: ctx.correlationId });
        case 'invalid_display_name':
          return errorResponse({
            status: 422,
            code: 'invalid_display_name',
            correlationId: ctx.correlationId,
            details: { reason: result.error.reason },
          });
        case 'server_error':
          logger.error(
            { errorId: `${ERROR_ID}.WRITE_SERVER_ERROR`, correlationId: ctx.correlationId },
            'admin.renewals.reply_to_write_server_error',
          );
          return errorResponse({ status: 500, code: 'server_error', correlationId: ctx.correlationId });
        default:
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${(result.error as { readonly kind: string }).kind}'`,
          );
      }
    }
    return successResponse(
      { email: result.value.email, displayName: result.value.displayName, changed: result.value.changed },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.WRITE_UNEXPECTED`,
        err: errKind(e),
        correlationId: ctx.correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.renewals.reply_to_write_unexpected',
    );
    return errorResponse({ status: 500, code: 'server_error', correlationId: ctx.correlationId });
  }
}
