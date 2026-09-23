/**
 * F119 T108 (FR-046) — POST `/api/broadcasts/templates/[id]/started`.
 *
 * The compose picker tells the server that a template was used as a starting
 * point, so `started_from_count` — the template library's only adoption
 * signal — stops reading `0` for every row. Nothing else: no draft is touched
 * and no content is written (the picker re-seeds the form on the client,
 * T140), which is exactly why the existing counting path
 * (`…/draft/[id]/snapshot-template`) could not serve here: it needs a SAVED
 * draft, and the member picks a template before one exists.
 *
 * Auth: the picker is shared between member compose and staff
 * compose-on-behalf (FR-039), so this accepts EITHER session; anonymous is
 * 401. A member session counts. A STAFF session counts only if it holds
 * `broadcasts.write` — the permission the staff compose-on-behalf draft route
 * (`/api/admin/broadcasts/draft`) gates on — asked of the evaluator through
 * `canPerform`, never a role literal: a read-only `manager` cannot compose,
 * so its "start" is inflation, not adoption (403, no bucket consumed, nothing
 * counted). The route stays in `api-route-exhaustiveness.test.ts`'s
 * `SESSION_ANY` allow-list because members must keep reaching it — a
 * role-matrix row would refuse them.
 *
 * The staff refusal writes no `permission_denied` row (unlike
 * `requireApiPermission`, which this route cannot use without a role-matrix
 * baseline row): the same trade the hand-rolled member/staff splits on the
 * credit-note routes make.
 *
 * A counter that anyone may increment is a counter anyone may inflate, so the
 * bucket is checked BEFORE the use case runs, atomically. The request carries
 * no body.
 *
 * Flag gate (T121 pattern): 503 `feature_disabled` when the US7 template
 * surface is off, matching the member template routes.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  broadcastsRateLimiter,
  countTemplateStart,
  makeCountTemplateStartDeps,
  isF71aUs7Enabled,
  f71aUs7DisabledReason,
} from '@/modules/broadcasts';
import { baseHeaders, jsonError } from '@/lib/broadcasts-route-helpers';
import { getCurrentSession } from '@/lib/auth-session';
import { canPerform } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';

/**
 * Generous for a human picking templates, tight against a scripted loop. Kept
 * module-private: a route file's only exports may be handlers and Next.js
 * segment config (`api-route-exhaustiveness.test.ts`).
 */
const TEMPLATE_START_RATE_MAX = 30;
const TEMPLATE_START_RATE_WINDOW_SECONDS = 60;

function templateStartRateKey(
  tenantSlug: string,
  userId: string,
): string {
  return `broadcasts:template-start:${tenantSlug}:${userId}`;
}

interface RouteParams {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs7Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs7DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const current = await getCurrentSession();
  if (!current) {
    return jsonError(401, 'no_session', correlationId);
  }

  // Refused ABOVE the bucket, so a refused call consumes nothing.
  // rbac-portal-identity-ok: member-portal subject vs staff split; the staff arm is decided by canPerform, never a literal.
  const isMemberSession = current.user.role === 'member';
  if (!isMemberSession && !canPerform(current.user.role, 'broadcasts.write')) {
    return jsonError(403, 'forbidden', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const { id } = await params;

  const limit = await broadcastsRateLimiter.checkLimit(
    templateStartRateKey(tenantCtx.slug, current.user.id),
    TEMPLATE_START_RATE_MAX,
    TEMPLATE_START_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return jsonError(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
    });
  }

  try {
    const result = await countTemplateStart(
      makeCountTemplateStartDeps(tenantCtx.slug),
      {
        tenantId: tenantCtx.slug as never,
        actorUserId: current.user.id,
        templateId: id,
        requestId: correlationId,
      },
    );

    if (!result.ok) {
      const kind = result.error.kind;
      switch (kind) {
        // A malformed id is answered as not-found, not 400: the id comes from
        // the picker's own list, so anything else is a probe and must not be
        // told which shapes exist.
        case 'invalid_input':
        case 'template_not_found':
          return jsonError(404, 'template_not_found', correlationId);
        case 'template_soft_deleted':
          return jsonError(410, 'template_soft_deleted', correlationId);
        default: {
          const _exhaustive: never = kind;
          void _exhaustive;
          return jsonError(500, 'internal_error', correlationId);
        }
      }
    }

    return NextResponse.json(
      { counted: true },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        templateId: id,
      },
      'broadcasts.template_start_count.unexpected_error',
    );
    return jsonError(500, 'internal_error', correlationId);
  }
}
