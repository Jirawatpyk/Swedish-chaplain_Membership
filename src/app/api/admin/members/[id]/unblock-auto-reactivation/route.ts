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
import { assertNever } from '@/lib/assert-never';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.MEMBER_UNBLOCK_AUTO_REACTIVATION.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
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

  const ctx = await requireRenewalAdminContext(
    request,
    'write',
    'renewals.write',
    ERROR_ID,
  );
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
          // Review of this branch — this arm RETURNED the 500, so the one
          // failure mode that means "two deploys disagree" produced a 500
          // with no log line at all, while the docblock above promised an
          // SRE rule keyed on `${ERROR_ID}.*` matches every 500 this route
          // can produce. Throwing lands it in the outer catch, which does
          // carry that id.
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${
              (result.error as { readonly kind: string }).kind
            }'`,
          );
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
