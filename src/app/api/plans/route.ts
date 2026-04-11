/**
 * GET /api/plans (T078, US1, contracts/plans-api.md § 1).
 *
 * Admin + manager read-only list endpoint. Parses query params with
 * zod, resolves the tenant from the request, calls the `listPlans`
 * use case, and serialises the result envelope verbatim.
 *
 * RBAC: `'plan' + 'read'` — admin and manager both allowed (F2 RBAC
 * extension T056). Member denied by the F1 role matrix.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  category: z.enum(['corporate', 'partnership']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  activeOnly: z.coerce.boolean().optional(),
  showDeleted: z.coerce.boolean().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Read-level access — admin + manager both allowed
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    raw[k] = v;
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_query',
          message: 'Invalid query parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  // Build filter sparsely — exactOptionalPropertyTypes: true rejects
  // explicit `undefined` values on optional fields, and the typed
  // filter object is readonly. Build a writable intermediate and
  // cast on the call site.
  const mutableFilter: {
    year?: number;
    category?: 'corporate' | 'partnership';
    q?: string;
    activeOnly?: boolean;
    showDeleted?: boolean;
  } = {};
  if (parsed.data.year !== undefined) mutableFilter.year = parsed.data.year;
  if (parsed.data.category !== undefined) mutableFilter.category = parsed.data.category;
  if (parsed.data.q !== undefined) mutableFilter.q = parsed.data.q;
  if (parsed.data.activeOnly !== undefined) mutableFilter.activeOnly = parsed.data.activeOnly;
  if (parsed.data.showDeleted !== undefined) mutableFilter.showDeleted = parsed.data.showDeleted;

  const filter: Parameters<typeof listPlans>[0]['filter'] = {
    ...(mutableFilter.year !== undefined && { year: asPlanYear(mutableFilter.year) }),
    ...(mutableFilter.category !== undefined && { category: mutableFilter.category }),
    ...(mutableFilter.q !== undefined && { q: mutableFilter.q }),
    ...(mutableFilter.activeOnly !== undefined && { activeOnly: mutableFilter.activeOnly }),
    ...(mutableFilter.showDeleted !== undefined && { showDeleted: mutableFilter.showDeleted }),
  };

  const result = await listPlans(
    { filter },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      feeConfigRepo: deps.feeConfigRepo,
      clock: deps.clock,
    },
  );

  if (result.ok) {
    return NextResponse.json(result.value, { status: 200 });
  }

  switch (result.error.type) {
    case 'fee_config_missing':
      logger.error(
        { requestId: ctx.requestId, tenant: tenant.slug },
        'list-plans: fee_config row missing for tenant',
      );
      return NextResponse.json(
        {
          error: {
            code: 'fee_config_missing',
            message: 'Tenant fee configuration has not been initialised.',
          },
        },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'list-plans: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
