/**
 * GET /api/plans/search (T080, US1/US6, contracts/plans-api.md § 11).
 *
 * Command palette backend. In-memory filter over current-year plans +
 * static action/navigate registries, role-filtered so managers never
 * see write actions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { searchPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import type { LocaleKey } from '@/modules/plans';

const querySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function resolveLocale(request: NextRequest): LocaleKey {
  const header = request.headers.get('accept-language') ?? 'en';
  const primary = header.split(',')[0]?.split('-')[0]?.toLowerCase();
  if (primary === 'th') return 'th';
  if (primary === 'sv') return 'sv';
  return 'en';
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    q: url.searchParams.get('q') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
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

  const input: Parameters<typeof searchPlans>[0] = {
    q: parsed.data.q,
    role: ctx.current.user.role,
    activeLocale: resolveLocale(request),
    ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
  };

  const result = await searchPlans(input, {
    tenant: deps.tenant,
    planRepo: deps.planRepo,
    clock: deps.clock,
  });

  if (result.ok) {
    return NextResponse.json(result.value, { status: 200 });
  }

  logger.error(
    { requestId: ctx.requestId },
    'search-plans: unexpected error',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}
