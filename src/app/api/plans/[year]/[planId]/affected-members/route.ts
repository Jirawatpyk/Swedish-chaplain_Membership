/**
 * GET /api/plans/[year]/[planId]/affected-members (T092, US3 FR-010).
 *
 * Returns the count of active/inactive members currently enrolled on
 * the plan, for the bundle-change warning dialog. Routing path lives
 * under /api/plans/ for URL coherence with F2, but the handler imports
 * the use case from @/modules/members because the inverse query is a
 * member-side concern (plan.md § Constitution Check III).
 *
 * RBAC: admin-only (bundle changes are admin-only).
 * SLO: p95 < 200ms at 500-member tenant (SC-008).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { affectedMembersCount } from '@/modules/members';
import type { PlanId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

const paramsSchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  planId: z.string().min(1),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; planId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Plan not found.' } },
      { status: 404 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);
  const result = await affectedMembersCount(
    { planId: parsed.data.planId as PlanId, planYear: parsed.data.year },
    { tenant, plans: deps.plans },
  );

  if (!result.ok) {
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'affected-members: unhandled',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      plan_id: parsed.data.planId,
      plan_year: parsed.data.year,
      count: result.value.count,
    },
    { status: 200 },
  );
}
