/**
 * GET `/api/admin/events/[eventId]`
 *
 * Phase 4 / US2 admin event detail endpoint per
 * `contracts/admin-events-api.md § GET detail`.
 *
 * Authz: admin OR manager (read-only). Member → 404 (FR-035) +
 * `role_violation_blocked` audit emit (F1 fix 2026-05-12).
 * Cross-tenant probe: use-case returns `not_found` Result; route maps
 * to 404 with bare body (no event-id echo) — surface-disclosure.
 *
 * Pagination: pageSize bounded [10, 200] per contract; default 50.
 * matchTypeFilter validated against the closed Domain `MATCH_TYPES`
 * set.
 */
import { type NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import {
  MATCH_TYPES,
  makeStandaloneAuditDeps,
} from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
import { clampPageSize, coerceBoolean } from '../_lib/query-helpers';
import { emitEventsRoleViolation } from '../_lib/role-violation-audit';

const DetailQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(10).max(200).optional().default(50),
  matchTypeFilter: z.enum(MATCH_TYPES).optional(),
  unmatchedOnly: z
    .preprocess(coerceBoolean, z.boolean())
    .optional()
    .default(false),
  q: z.string().min(1).max(200).optional(),
});


export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ eventId: string }> },
) {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  const { eventId } = await ctx.params;

  // R002 (staff-review fix 2026-05-13): validate eventId shape BEFORE
  // the role gate so an oversized eventId from a member actor cannot
  // bloat the audit log. The role-violation emit echoes `eventId`
  // into both the human-readable summary and the audit payload;
  // capping `.length` here is the audit-DoS defence. Empty-string
  // guard preserved for the same reason — emitting a 0-length probe
  // marker into 35 enum-tagged audit rows adds no signal.
  if (!eventId || eventId.length > 200) {
    return new NextResponse(null, { status: 404 });
  }

  // R003 (staff-review fix 2026-05-13): see /api/admin/events/route.ts
  // for the rationale on switching from `requireSession('staff').catch`
  // to `getCurrentSession()` (avoids swallowing infrastructure errors).
  const session = await getCurrentSession();
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    // Narrowed `role` passed directly so future Role-union additions
    // fail to compile against the helper's `'member' | 'manager'`.
    await emitEventsRoleViolation(request, {
      actorUserId: session.user.id,
      actorRole: role,
      attemptedRoute: `/api/admin/events/${eventId}`,
      attemptedAction: 'load_event_detail',
      eventId,
    });
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const { value: pageSize, clamped: pageSizeClamped } = clampPageSize(
    searchParams.get('pageSize'),
    10,
    200,
    50,
  );
  const parsed = DetailQuerySchema.safeParse({
    page: searchParams.get('page') ?? undefined,
    pageSize,
    matchTypeFilter: searchParams.get('matchTypeFilter') ?? undefined,
    unmatchedOnly: searchParams.get('unmatchedOnly') ?? undefined,
    q: searchParams.get('q') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { title: 'Invalid query params', detail: parsed.error.issues },
      { status: 400 },
    );
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    // host-header / tenant
    // resolution failure surfaces as 500 rather than letting Next.js
    // render its default error page. Logged for ops triage.
    logger.error(
      {
        event: 'admin_event_detail_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
      },
      '[F6] resolveTenantFromRequest threw on detail route',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
  // trim `q` and treat whitespace-only
  // as null so the repo doesn't hit ilike with an empty pattern.
  const trimmedQ = parsed.data.q?.trim();
  // wrap raw runInTenant rejection path.
  let result: Awaited<ReturnType<typeof runLoadEventDetail>>;
  try {
    result = await runLoadEventDetail(tenantCtx.slug, {
      eventId,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      matchTypeFilter: parsed.data.matchTypeFilter ?? null,
      unmatchedOnly: parsed.data.unmatchedOnly,
      q: trimmedQ && trimmedQ.length > 0 ? trimmedQ : null,
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_detail_route_throw',
        err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
        eventId,
      },
      '[F6] /api/admin/events/[eventId] — runLoadEventDetail threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  if (!result.ok) {
    if (result.error.kind === 'not_found') {
      // R6-B7 staff-review fix (2026-05-13): emit a durable
      // `cross_tenant_probe` audit row IN ADDITION to the ephemeral
      // `logger.warn` marker below. Constitution v1.4.0 Principle I
      // sub-clause 4: "cross-tenant access attempts (even failed
      // ones) MUST be logged as high-severity security events."
      // RLS cannot distinguish "row missing" from "row exists in
      // another tenant" without a root-db probe (itself a leak
      // surface). Emitting the audit at every 404 means SREs get a
      // 5-year durable trail to correlate enumeration patterns —
      // logger.warn alone rotates within days.
      //
      // For admin surface: `probedTenantId === signedTenantId` (no
      // signature; the actor is authorised for their tenant and
      // probed an eventId not present in it). Audit-emit failure
      // MUST NEVER block the 404 — wrap in try/catch (mirrors the
      // FR-035 role_violation_blocked emit pattern).
      const eventIdHash = crypto
        .createHash('sha256')
        .update(eventId)
        .digest('hex')
        .slice(0, 16);
      try {
        const auditDeps = makeStandaloneAuditDeps();
        await auditDeps.emitStandalone({
          eventType: 'cross_tenant_probe',
          tenantId: asTenantId(tenantCtx.slug),
          actorType: session.user.role === 'admin' ? 'admin' : 'manager',
          actorUserId: asUserId(session.user.id),
          occurredAt: new Date(),
          summary: `admin event-detail 404 — possible enumeration probe (event_id_hash=${eventIdHash})`,
          payload: {
            severity: 'warn',
            probedTenantId: asTenantId(tenantCtx.slug),
            signedTenantId: asTenantId(tenantCtx.slug),
            sourceIp:
              request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
              request.headers.get('x-real-ip') ??
              'unknown',
            requestId: request.headers.get('x-request-id') ?? null,
            attemptedRoute: `/api/admin/events/${eventIdHash}`,
          },
        });
      } catch (auditErr) {
        // Audit emit failure must not block 404 — log + continue.
        logger.error(
          {
            event: 'f6_admin_cross_tenant_probe_audit_failed',
            tenantSlug: tenantCtx.slug,
            errName: auditErr instanceof Error ? auditErr.name : 'unknown',
          },
          '[F6] admin cross_tenant_probe audit emit failed (suppressed — 404 still returned)',
        );
      }
      // Preserve the ephemeral pino marker too — gives SRE
      // dashboards a faster signal than waiting for audit_log
      // aggregation. event_id_hash matches the audit summary line
      // for correlation across both sinks.
      logger.warn(
        {
          event: 'admin_event_detail_not_found',
          actor_user_id: session.user.id,
          tenant_slug: tenantCtx.slug,
          event_id_hash: eventIdHash,
        },
        '[F6] admin event-detail 404 — cross-tenant-probe (audit emitted)',
      );
      return new NextResponse(null, { status: 404 });
    }
    logger.error(
      { event: 'admin_event_detail_error', error: result.error, eventId },
      'admin event detail use-case failed',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  // see /api/admin/events/route.ts.
  const responseHeaders: Record<string, string> = {};
  if (pageSizeClamped) responseHeaders['X-PageSize-Clamped'] = 'true';
  return NextResponse.json(result.value, {
    status: 200,
    headers: responseHeaders,
  });
}
