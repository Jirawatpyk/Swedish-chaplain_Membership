/**
 * T060 — GET `/api/admin/events/[eventId]`
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
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runLoadEventDetail } from '@/lib/events-admin-deps';
import { MATCH_TYPES, makeStandaloneAuditDeps } from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';

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

function clampPageSize(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function coerceBoolean(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (v === '' || v === 'true' || v === '1') return v === '' ? false : true;
  if (v === 'false' || v === '0') return false;
  return v;
}

/**
 * FR-035 audit helper — see /api/admin/events/route.ts for the same
 * pattern + rationale. Try/catch wrapping ensures audit failure never
 * blocks the 404 response. Pino fallback handles DB outage (audit-port
 * dual-write).
 */
async function emitRoleViolation(
  request: NextRequest,
  actorUserId: string | null,
  actorRole: 'member' | 'manager',
  eventId: string,
): Promise<void> {
  try {
    const tenantCtx = resolveTenantFromRequest(request);
    const deps = makeStandaloneAuditDeps();
    await deps.emitStandalone({
      eventType: 'role_violation_blocked',
      tenantId: asTenantId(tenantCtx.slug),
      actorType: actorRole,
      actorUserId: actorUserId ? asUserId(actorUserId) : null,
      occurredAt: new Date(),
      summary: `${actorRole} attempted GET /api/admin/events/${eventId} (load_event_detail)`,
      payload: {
        severity: 'warn',
        actorUserId: asUserId(actorUserId ?? '00000000-0000-0000-0000-000000000000'),
        actorRole,
        attemptedRoute: `/api/admin/events/${eventId}`,
        attemptedAction: 'load_event_detail',
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

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ eventId: string }> },
) {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  const { eventId } = await ctx.params;

  const session = await requireSession('staff').catch(() => null);
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    await emitRoleViolation(
      request,
      session.user.id,
      role as 'member',
      eventId,
    );
    return new NextResponse(null, { status: 404 });
  }

  if (!eventId || eventId.length > 200) {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const pageSize = clampPageSize(searchParams.get('pageSize'), 10, 200, 50);
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

  const tenantCtx = resolveTenantFromRequest(request);
  const result = await runLoadEventDetail(tenantCtx.slug, {
    eventId,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    matchTypeFilter: parsed.data.matchTypeFilter ?? null,
    unmatchedOnly: parsed.data.unmatchedOnly,
    q: parsed.data.q ?? null,
  });

  if (!result.ok) {
    if (result.error.kind === 'not_found') {
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

  return NextResponse.json(result.value, { status: 200 });
}
