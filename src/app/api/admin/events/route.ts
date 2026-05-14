/**
 * GET `/api/admin/events`
 *
 * Phase 4 / US2 admin events list endpoint per
 * `contracts/admin-events-api.md § GET list`.
 *
 * Authz: admin OR manager (read-only). Member role → 404 per FR-035
 * surface-disclosure prevention (route must not reveal whether the
 * endpoint exists to non-staff actors). Member-attempt + kill-switch
 * paths emit `role_violation_blocked` audit (FR-035 mandate; F1 fix
 * 2026-05-12). Audit emission is wrapped in try/catch — an audit
 * failure must NEVER block the 404 response (mirrors F8 precedent in
 * `src/app/api/admin/renewals/route.ts:62-87`).
 *
 * Tenant scope: every query path goes through `runListEvents` which
 * wraps `runInTenant(ctx, fn)` — Constitution Principle I.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { eventsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { runListEvents } from '@/lib/events-admin-deps';
import { clampPageSize, coerceBoolean } from './_lib/query-helpers';
import { emitEventsRoleViolation } from './_lib/role-violation-audit';

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  pageSize: z.coerce.number().int().min(10).max(100).optional().default(25),
  includeArchived: z
    .preprocess(coerceBoolean, z.boolean())
    .optional()
    .default(false),
  partnerBenefitOnly: z
    .preprocess(coerceBoolean, z.boolean())
    .optional()
    .default(false),
  culturalEventOnly: z
    .preprocess(coerceBoolean, z.boolean())
    .optional()
    .default(false),
  categoryFilter: z.string().min(1).max(120).optional(),
});


export async function GET(request: NextRequest) {
  // kill-switch returns 404 (surface disclosure prevention).
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  // auth + RBAC. Member role returns 404 (NOT 403) so the existence
  // of the admin surface is not leaked to non-staff actors.
  // R003 (staff-review fix 2026-05-13): use `getCurrentSession`
  // instead of `requireSession(...).catch(() => null)`. The previous
  // pattern swallowed every error class — including DB-connection-
  // lost / cookie-parse infrastructure failures — and falsely
  // surfaced them as 404s. `getCurrentSession` distinguishes
  // "no session" (returns null) from infrastructure failure (throws),
  // letting the framework's error boundary turn the latter into 500.
  // Audit emission per FR-035 mandate.
  const session = await getCurrentSession();
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    // TS narrows `role` to `'member'` after the guard. Passing `role`
    // directly (no `as 'member'` cast) means a future Role-union
    // addition (e.g. `'treasurer'`) fails this call to compile against
    // the helper's `'member' | 'manager'` param — surfaceable signal,
    // not silent audit mis-labelling.
    await emitEventsRoleViolation(request, {
      actorUserId: session.user.id,
      actorRole: role,
      attemptedRoute: '/api/admin/events',
      attemptedAction: 'list_events',
      eventId: null,
    });
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const { value: pageSize, clamped: pageSizeClamped } = clampPageSize(
    searchParams.get('pageSize'),
    10,
    100,
    25,
  );
  const parsed = ListQuerySchema.safeParse({
    page: searchParams.get('page') ?? undefined,
    pageSize,
    includeArchived: searchParams.get('includeArchived') ?? undefined,
    partnerBenefitOnly: searchParams.get('partnerBenefitOnly') ?? undefined,
    culturalEventOnly: searchParams.get('culturalEventOnly') ?? undefined,
    categoryFilter: searchParams.get('categoryFilter') ?? undefined,
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
    // tenant-resolve failure → 500.
    logger.error(
      {
        event: 'admin_events_list_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] resolveTenantFromRequest threw on list route',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }
  // H3 fix (verify-finding): trim categoryFilter; null on whitespace-only.
  const trimmedCategory = parsed.data.categoryFilter?.trim();
  // R6-W3 staff-review fix (2026-05-13): wrap the use-case dispatch in
  // an OTel root span so SLO-F6-002 (admin list p95 < 500ms) is
  // measurable from trace data. Attributes are bounded-cardinality
  // (tenant slug + integer page + integer pageSize) per the
  // events-tracer redaction contract in src/lib/otel-tracer.ts:97-101.
  // wrap runInTenant raw rejection path. Result.err returns flow
  // normally; only DB-connection-lost class throws should hit the
  // catch.
  let result: Awaited<ReturnType<typeof runListEvents>>;
  try {
    result = await withActiveSpan(
      eventsTracer(),
      'admin_events_list',
      {
        'tenant.id': tenantCtx.slug,
        'f6.page': parsed.data.page,
        'f6.page_size': parsed.data.pageSize,
      },
      async () =>
        runListEvents(tenantCtx.slug, {
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          includeArchived: parsed.data.includeArchived,
          partnerBenefitOnly: parsed.data.partnerBenefitOnly,
          culturalEventOnly: parsed.data.culturalEventOnly,
          categoryFilter: trimmedCategory && trimmedCategory.length > 0 ? trimmedCategory : null,
        }),
    );
  } catch (e) {
    // R9-I1 staff-review fix (2026-05-14): scrub container paths
    // (`/var/task/...`), node_modules, webpack-internal:/// from the
    // stack BEFORE pino captures it. The pino REDACT_PATHS list has no
    // entry for `*.stack`, so this catch site was leaking deployment
    // filesystem structure into observability sinks (round-9 code-
    // reviewer agent — closes the round-8 W2 contract carry).
    logger.error(
      {
        event: 'admin_events_list_route_throw',
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
      },
      '[F6] /api/admin/events list — runListEvents threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  if (!result.ok) {
    logger.error(
      { event: 'admin_events_list_error', error: result.error },
      'admin events list use-case failed',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  // surface the clamping signal to
  // API consumers via an explicit response header so a CLI/script
  // caller that asked for pageSize=5 and got 10 rows can detect the
  // discrepancy without parsing pagination metadata.
  const responseHeaders: Record<string, string> = {};
  if (pageSizeClamped) responseHeaders['X-PageSize-Clamped'] = 'true';
  return NextResponse.json(result.value, {
    status: 200,
    headers: responseHeaders,
  });
}
