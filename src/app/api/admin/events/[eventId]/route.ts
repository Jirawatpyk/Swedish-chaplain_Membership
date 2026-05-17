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
import { redactStack } from '@/lib/redact-stack';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { eventsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { safeEmitStandalone } from '@/lib/events-safe-emit-standalone';
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
      // Round-3 type-M closure — brand at callsite for consistency
      // with the 5 other admin write routes' actor-id discipline.
      actorUserId: asUserId(session.user.id),
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
  // R6-W3 staff-review fix (2026-05-13): wrap use-case dispatch in an
  // OTel root span so SLO-F6-003 (admin detail p95 < 800ms) is
  // measurable. Attributes bounded-cardinality only — eventId is NOT
  // included verbatim (could be probing PII / unbounded label) but
  // page/pageSize/has_q/unmatchedOnly are safe to surface.
  let result: Awaited<ReturnType<typeof runLoadEventDetail>>;
  try {
    result = await withActiveSpan(
      eventsTracer(),
      'admin_events_detail',
      {
        'tenant.id': tenantCtx.slug,
        'f6.page': parsed.data.page,
        'f6.page_size': parsed.data.pageSize,
        'f6.unmatched_only': parsed.data.unmatchedOnly,
        'f6.has_search_query': !!(trimmedQ && trimmedQ.length > 0),
      },
      async () =>
        runLoadEventDetail(tenantCtx.slug, {
          eventId,
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          matchTypeFilter: parsed.data.matchTypeFilter ?? null,
          unmatchedOnly: parsed.data.unmatchedOnly,
          q: trimmedQ && trimmedQ.length > 0 ? trimmedQ : null,
        }),
    );
  } catch (e) {
    // R9-I1 staff-review fix (2026-05-14) — see `route.ts` sibling
    // for full rationale. `redactStack` strips container paths
    // before pino sees the stack (round-8 W2 contract carry).
    logger.error(
      {
        event: 'admin_event_detail_route_throw',
        err:
          e instanceof Error
            ? {
                name: e.name,
                message: e.message,
                stack:
                  typeof e.stack === 'string'
                    ? (redactStack(e.stack) ?? null)
                    : null,
              }
            : String(e),
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
      // MUST NEVER block the 404 — delegated to `safeEmitStandalone`
      // (R7-F) which suppresses and logs internally (mirrors the
      // FR-035 role_violation_blocked emit pattern).
      const eventIdHash = crypto
        .createHash('sha256')
        .update(eventId)
        .digest('hex')
        .slice(0, 16);
      // R7-G staff-review fix (2026-05-13): cap X-Request-ID at 200
      // chars before writing to audit_log.payload — mirrors the W1
      // cap on the webhook route. audit_log.payload is JSONB (no
      // column-level size enforcement); an authenticated admin
      // sending an oversized header would otherwise bloat the audit
      // row. Lower risk than W1 (admin auth required vs. public
      // webhook) but consistency closes the inconsistency defect.
      //
      // R8-S1 round-8 fix: empty/whitespace-only header is coerced
      // to `null` here (line 230) rather than the webhook's
      // `NO_REQUEST_ID` sentinel because `audit_log.payload` is JSONB
      // and accepts null cleanly. The webhook path writes to
      // `audit_log.request_id` which is a NOT-NULL forensically-
      // indexed text column where null cannot land, hence the
      // sentinel string at that callsite. Different downstream
      // semantics, intentionally diverged.
      const rawAdminRequestId =
        (request.headers.get('x-request-id')?.trim() ?? '').slice(0, 200);
      // R7-F staff-review fix (2026-05-13): use the shared
      // `safeEmitStandalone` helper instead of an inline bare
      // try/catch so this emit follows the same structured
      // logEvent/logMsg shape as every other F6 standalone emit
      // (webhook config-load + signature-reject paths). Audit
      // failure still cannot block the 404 response.
      // Phase B B2 — emit `event_detail_not_found_probe` (severity:
      // info) instead of the high-severity `cross_tenant_probe` for
      // legitimate 404s. RLS cannot discriminate "row missing" from
      // "row in another tenant" without a root-db probe (itself a
      // leak surface), so we treat the 404 as info-level by default.
      // Confirmed cross-tenant signal would be emitted elsewhere with
      // discriminating evidence (e.g., a SQL-injected slug).
      //
      // H8.2 / NEW-I3 — `probedTenantId` and `signedTenantId` are
      // ALWAYS identical at this callsite (both set to `tenantCtx.slug`).
      // The redundant pair is intentional: it matches the
      // `cross_tenant_probe` payload shape exactly so SRE dashboards
      // can union the two event types on the same WHERE clause and
      // discriminate by severity. A future feature that adds
      // rate-gated probing (e.g. admin enumerating >100 events/min
      // within a tenant) could promote info-level → warn-level on the
      // same payload shape — but that's a F6.2 concern, not a bug in
      // this route. This route literally cannot observe cross-tenant
      // evidence (RLS hides rows from other tenants completely).
      await safeEmitStandalone(
        makeStandaloneAuditDeps(),
        {
          eventType: 'event_detail_not_found_probe',
          tenantId: asTenantId(tenantCtx.slug),
          actorType: session.user.role === 'admin' ? 'admin' : 'manager',
          actorUserId: asUserId(session.user.id),
          occurredAt: new Date(),
          summary: `admin event-detail 404 (event_id_hash=${eventIdHash}) — info-level probe; alert only on cross_tenant_probe`,
          payload: {
            severity: 'info',
            probedTenantId: asTenantId(tenantCtx.slug),
            signedTenantId: asTenantId(tenantCtx.slug),
            sourceIp:
              request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
              request.headers.get('x-real-ip') ??
              'unknown',
            requestId: rawAdminRequestId.length > 0 ? rawAdminRequestId : null,
            attemptedRoute: `/api/admin/events/${eventIdHash}`,
          },
        },
        {
          tenantSlug: tenantCtx.slug,
          logEvent: 'f6_admin_event_detail_not_found_probe_audit_failed',
          logMsg:
            '[F6] event_detail_not_found_probe audit emit failed (suppressed — 404 still returned)',
        },
      );
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
