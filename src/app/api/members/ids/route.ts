/**
 * GET /api/members/ids — resolve the member ids matching the current directory
 * filter, for the "Select all N matching" bulk affordance (#2 members-ux).
 *
 * The directory table only renders one page (PAGE_SIZE=50); TanStack selection
 * only tracks rendered rows. This endpoint returns the SAME matching set the
 * page shows — capped at `BULK_CAP` (100, the bulk-action ceiling) — so a bulk
 * action can reach every match, not just the visible page. The filter is parsed
 * by the shared `parseDirectoryFilterFromParams` so this endpoint and the page
 * can never disagree on what the filter matches.
 *
 * Archived members are EXCLUDED — they are not a valid bulk target (mirrors
 * `isMemberRowSelectable`), so `?status=archived` yields an empty set.
 *
 * RBAC: `members` / `read` (admin + manager, same as the directory GET). The
 * bulk ACTION at POST /api/members/bulk stays admin-only, so returning the id
 * list to a manager grants no capability beyond the rows they can already read.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { directorySearchWithCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  parseDirectoryFilterFromParams,
  parseDirectorySort,
  parseDirectoryOrder,
} from '@/lib/members-directory-filter';
import { BULK_CAP } from '@/lib/members-bulk-constants';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;

  const filter = parseDirectoryFilterFromParams(raw);

  // Only non-archived members are a valid bulk target. Drop 'archived' from the
  // status set; if the caller filtered to ONLY archived, nothing is selectable.
  const selectableStatus = filter.status.filter((s) => s !== 'archived');
  if (selectableStatus.length === 0) {
    return NextResponse.json({ ids: [], total: 0, capped: false }, { status: 200 });
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);
  const now = new Date();

  // Forward the active sort/order so the capped set matches the FIRST 100 of the
  // admin's visible order (e.g. engagement ASC = most at-risk first) — otherwise
  // a >100-match "select all matching" would email members in the repo default
  // order, not the ones the admin sees checked. Below the cap it is moot.
  const sort = parseDirectorySort(raw.sort);
  const order = parseDirectoryOrder(raw.order);

  const result = await directorySearchWithCount(
    { tenant, memberRepo: deps.memberRepo },
    {
      ...(filter.q !== undefined ? { q: filter.q } : {}),
      ...(filter.planId !== undefined ? { planId: filter.planId } : {}),
      ...(filter.riskBand !== undefined ? { riskBand: filter.riskBand } : {}),
      ...(filter.portalNeedsInvite ? { portalNeedsInvite: { now } } : {}),
      ...(sort ? { sort, ...(order ? { order } : {}) } : {}),
      status: selectableStatus,
      limit: BULK_CAP,
      offset: 0,
    },
  );

  if (!result.ok) {
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'members-ids: directory search failed',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  const ids = result.value.items.map((row) => row.member.memberId);
  return NextResponse.json(
    { ids, total: result.value.total, capped: result.value.total > BULK_CAP },
    { status: 200 },
  );
}
