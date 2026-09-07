/**
 * F8 Phase 5 Wave C · T142 (part 2 / 2) —
 * POST `/api/admin/members/[id]/unblock-auto-reactivation`.
 *
 * Slug name `[id]` matches the existing F3 admin route family
 * (`/api/admin/members/[id]/preferred-locale` etc.) — Next.js requires
 * consistent dynamic-segment slug names within the same path tree.
 *
 * Inverse of block-auto-reactivation. Resets all four block-related
 * columns to (FALSE, NULL, NULL, NULL) atomically per migration 0094's
 * CHECK constraint. Audit emit only on actual flag change.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { unblockAutoReactivation, makeRenewalsDeps } from '@/modules/renewals';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Used for BOTH the
 * `.CONTEXT_RESOLUTION_FAILED` line the admin gate emits before this
 * handler's try block and the `.UNEXPECTED` line its outer catch emits, so
 * an SRE rule keyed on `F8.MEMBER_UNBLOCK_AUTO_REACTIVATION.*` matches every 500 this route can produce.
 */
const ERROR_ID = 'F8.MEMBER_UNBLOCK_AUTO_REACTIVATION';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write', 'renewals.write', ERROR_ID);
  if ('response' in ctx) return ctx.response;

  const { id: memberId } = await context.params;
  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await unblockAutoReactivation(deps, {
      tenantId: tenantCtx.slug,
      memberId,
      actorUserId: ctx.current.user.id,
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the
      // gate above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'member_not_found':
          return errorResponse({
            status: 404,
            code: 'member_not_found',
            correlationId: ctx.correlationId,
          });
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        }
      }
    }
    return successResponse(
      { was_blocked: result.value.wasBlocked },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        memberId,
        tenantId: tenantCtx.slug,
      },
      'unblock-auto-reactivation route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
