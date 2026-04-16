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
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { PaletteMemberEntity } from '@/components/command-palette/registry';

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
    // T069 — also search members for the palette. Ordering: plan
    // matches first, then members, mirroring the `groups.tsx` render
    // order. Member search is admin/manager-read-gated (the admin
    // context gate above already blocks the `member` role from
    // reaching this surface).
    let members: readonly PaletteMemberEntity[] = [];
    try {
      const membersDeps = buildMembersDeps(tenant);
      const membersResult = await directorySearch(
        { tenant, memberRepo: membersDeps.memberRepo },
        {
          q: parsed.data.q,
          limit: parsed.data.limit ?? 10,
        },
      );
      if (membersResult.ok) {
        members = membersResult.value.items.map((row) => ({
          member_id: row.member.memberId,
          company_name: row.member.companyName,
          primary_contact_name: row.primaryContact
            ? `${row.primaryContact.firstName} ${row.primaryContact.lastName}`.trim()
            : null,
          status: row.member.status,
          url: `/admin/members/${row.member.memberId}`,
        }));
      }
    } catch (e) {
      // Non-fatal — plans + registries already rendered. Log and
      // continue so a single-module outage doesn't blank the palette.
      logger.warn(
        { requestId: ctx.requestId, err: e },
        'palette.members_search_failed',
      );
    }

    return NextResponse.json(
      {
        results: { ...result.value.results, members },
      },
      { status: 200 },
    );
  }

  // server_error from use case (e.g. DB connection failure)
  logger.error(
    { requestId: ctx.requestId, err: result.error },
    'search-plans: server error',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}
