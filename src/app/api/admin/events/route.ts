/**
 * T060 — GET `/api/admin/events`
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
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runListEvents } from '@/lib/events-admin-deps';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
import { makeStandaloneAuditDeps } from '@/modules/events';

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

// `pageSize` is clamped to [10, 100]. Behaviour:
//   - non-numeric / null → default (25)
//   - below `min` → clamp UP to `min` (UX: lower-than-min must not 400)
//   - above `max` → clamp DOWN to `max`
// Same convention as F4/F8 routes.
function clampPageSize(raw: string | null, min: number, max: number, def: number): { value: number; clamped: boolean } {
  if (raw === null) return { value: def, clamped: false };
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return { value: def, clamped: false };
  if (n < min) return { value: min, clamped: true };
  if (n > max) return { value: max, clamped: true };
  return { value: n, clamped: false };
}

/**
 * H2 fix (verify-finding 2026-05-12): return `undefined` for any
 * unrecognised string so `z.preprocess(coerceBoolean, z.boolean())`
 * falls through to the schema default. Previously, an unrecognised
 * non-empty string (`?partnerBenefitOnly=xyzzy`) was passed through
 * unchanged; `z.boolean()` then ran `Boolean(s)` → `true` — silent
 * filter activation on garbage input.
 */
function coerceBoolean(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true' || v === '1') return true;
  return undefined;
}

/**
 * FR-035 audit helper — emits `role_violation_blocked` on member-role
 * and kill-switch 404 paths. Wrapped in try/catch so audit-write
 * failures never block the 404 response (F8 precedent — observability
 * must not become an availability dependency). Pino fallback emits
 * `audit_secondary_tx_failure: true` on DB failure inside the port.
 */
async function emitRoleViolation(
  request: NextRequest,
  actorUserId: string | null,
  actorRole: 'member' | 'manager',
  attemptedAction: string,
): Promise<void> {
  // E5 fix (verify-finding 2026-05-12): hoist tenant resolution OUT of
  // the audit-emit try so a host-header / tenant-validation failure
  // surfaces as `tenant_resolve_failed_during_role_violation_audit`
  // (a distinct ops-alert discriminator) instead of being mislabelled
  // as `f6_audit_emit_failed`. Audit-emit retains its own try/catch.
  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'tenant_resolve_failed_during_role_violation_audit',
        err: e instanceof Error ? e.message : String(e),
        attemptedAction,
      },
      '[F6] tenant resolution failed during role_violation_blocked emit — 404 still served',
    );
    return;
  }
  try {
    const deps = makeStandaloneAuditDeps();
    await deps.emitStandalone({
      eventType: 'role_violation_blocked',
      tenantId: asTenantId(tenantSlug),
      actorType: actorRole,
      actorUserId: actorUserId ? asUserId(actorUserId) : null,
      occurredAt: new Date(),
      summary: `${actorRole} attempted GET /api/admin/events (${attemptedAction})`,
      payload: {
        severity: 'warn',
        actorUserId: asUserId(actorUserId ?? '00000000-0000-0000-0000-000000000000'),
        actorRole,
        attemptedRoute: '/api/admin/events',
        attemptedAction,
        blockedAt: 'app_layer',
      },
    });
  } catch (e) {
    logger.error(
      { event: 'f6_audit_emit_failed', err: e instanceof Error ? e.message : String(e) },
      '[F6] role_violation_blocked audit emit failed — 404 response still served',
    );
  }
}

export async function GET(request: NextRequest) {
  // FR-035 — kill-switch returns 404 (surface disclosure prevention).
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  // FR-035 — auth + RBAC. Member role returns 404 (NOT 403) so the
  // existence of the admin surface is not leaked to non-staff actors.
  // Audit emission per FR-035 mandate.
  const session = await requireSession('staff').catch(() => null);
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    // Only `member` role reaches here — `requireSession('staff')`
    // already redirects anonymous + non-staff invalid sessions.
    await emitRoleViolation(
      request,
      session.user.id,
      role as 'member',
      'list_events',
    );
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
    // T7 fix (verify-finding 2026-05-12): tenant-resolve failure → 500.
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
  // E6 fix (verify-finding 2026-05-12): wrap runInTenant raw rejection
  // path. Result.err returns flow normally; only DB-connection-lost
  // class throws should hit the catch.
  let result: Awaited<ReturnType<typeof runListEvents>>;
  try {
    result = await runListEvents(tenantCtx.slug, {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      includeArchived: parsed.data.includeArchived,
      partnerBenefitOnly: parsed.data.partnerBenefitOnly,
      culturalEventOnly: parsed.data.culturalEventOnly,
      categoryFilter: trimmedCategory && trimmedCategory.length > 0 ? trimmedCategory : null,
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_events_list_route_throw',
        err: e instanceof Error ? { name: e.name, message: e.message, stack: e.stack } : String(e),
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

  // E8 fix (verify-finding 2026-05-12): surface the clamping signal to
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
