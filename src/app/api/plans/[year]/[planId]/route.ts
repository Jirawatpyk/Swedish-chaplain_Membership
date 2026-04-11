/**
 * GET /api/plans/[year]/[planId] (T079, US1 + US3, contracts/plans-api.md § 2).
 *
 * Returns one plan or 404. The 404 path is deliberately identical for
 * "plan never existed" and "plan belongs to a different tenant" — the
 * RLS layer silently filters cross-tenant rows, and the use case
 * appends a `plan_not_found` audit event that the F13 scan correlates
 * offline. Request path NEVER runs a BYPASS RLS query (critique E6).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { asPlanSlug, asPlanYear, getPlan } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';

const pathSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  planId: z.string().regex(/^[a-z0-9-]{1,63}$/, 'plan slug must match [a-z0-9-]{1,63}'),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; planId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const raw = await params;
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_path',
          message: 'Invalid path parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  const result = await getPlan(
    {
      planId: asPlanSlug(parsed.data.planId),
      year: asPlanYear(parsed.data.year),
    },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      audit: deps.audit,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp,
      method: 'GET',
      route: `/api/plans/${parsed.data.year}/${parsed.data.planId}`,
    },
  );

  if (result.ok) {
    return NextResponse.json(
      {
        plan_id: result.value.plan_id,
        plan_year: result.value.plan_year,
        plan_name: result.value.plan_name,
        description: result.value.description,
        sort_order: result.value.sort_order,
        plan_category: result.value.plan_category,
        member_type_scope: result.value.member_type_scope,
        annual_fee_minor_units: result.value.annual_fee_minor_units,
        includes_corporate_plan_id: result.value.includes_corporate_plan_id,
        min_turnover_minor_units: result.value.min_turnover_minor_units,
        max_turnover_minor_units: result.value.max_turnover_minor_units,
        max_duration_years: result.value.max_duration_years,
        max_member_age: result.value.max_member_age,
        benefit_matrix: result.value.benefit_matrix,
        is_active: result.value.is_active,
        deleted_at: result.value.deleted_at?.toISOString() ?? null,
        created_at: result.value.created_at.toISOString(),
        updated_at: result.value.updated_at.toISOString(),
      },
      { status: 200 },
    );
  }

  if (result.error.type === 'not_found') {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Plan not found.' } },
      { status: 404 },
    );
  }

  logger.error(
    { requestId: ctx.requestId },
    'get-plan: unhandled error variant',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}
