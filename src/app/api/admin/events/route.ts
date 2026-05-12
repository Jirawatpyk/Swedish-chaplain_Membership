/**
 * T060 — GET `/api/admin/events`
 *
 * Phase 4 / US2 admin events list endpoint per
 * `contracts/admin-events-api.md § GET list`.
 *
 * Authz: admin OR manager (read-only). Member role → 404 per FR-035
 * surface-disclosure prevention (route must not reveal whether the
 * endpoint exists to non-staff actors).
 *
 * Kill-switch: when `FEATURE_F6_EVENTCREATE=false` returns 404 — same
 * surface-disclosure pattern as F8's kill-switch + audit emit (audit
 * landing in Phase 10 cross-cutting; for Phase 4 the route returns
 * the 404 without emitting since no f6 audit event covers
 * "admin_list_blocked_by_flag" yet).
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

// `pageSize` is clamped to [10, 100] at the schema layer. Out-of-bounds
// values get the schema default — same convention as F4/F8 routes.
// `?pageSize=5` (below min) is invalid; treat as default by clamping in
// the GET handler (lower-than-min should not 400 per UX convention).
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

export async function GET(request: NextRequest) {
  // FR-035 — kill-switch returns 404 (surface disclosure prevention).
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  // FR-035 — auth + RBAC. Member role returns 404 (NOT 403) so the
  // existence of the admin surface is not leaked to non-staff actors.
  const session = await requireSession('staff').catch(() => null);
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const pageSize = clampPageSize(
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

  const tenantCtx = resolveTenantFromRequest(request);
  const result = await runListEvents(tenantCtx.slug, {
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    includeArchived: parsed.data.includeArchived,
    partnerBenefitOnly: parsed.data.partnerBenefitOnly,
    culturalEventOnly: parsed.data.culturalEventOnly,
    categoryFilter: parsed.data.categoryFilter ?? null,
  });

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

  return NextResponse.json(result.value, { status: 200 });
}
