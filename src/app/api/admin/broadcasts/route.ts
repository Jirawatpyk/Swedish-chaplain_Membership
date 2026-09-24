/**
 * T108 — GET `/api/admin/broadcasts`.
 *
 * Admin review queue list. Supports server-side filter (status, member)
 * + sort + cursor pagination via `BroadcastsRepo.listByTenantStatus`.
 *
 * Authz: admin OR manager (manager is read-only on this surface per Q12
 * spec § 2.1).
 *
 * F119 T109 / T110 / T112 — the dashboard contract
 * (contracts/dashboard-and-notifications.md § 1): each item carries the
 * FR-026 columns and, on sent rows, FR-029's delivery results (the SAME
 * projection the page renders — `loadAdminBroadcastQueue`); the body carries
 * the per-stage counts (FR-025, `null` when that read failed); and
 * `?status=approved&sort=scheduled_for&from=now` is the Upcoming sends preset
 * (FR-028). `from` accepts `now` only — any other value is refused rather than
 * read as "no bound". No contact-level field is selected anywhere (FR-036).
 *
 * FR-030 — `fromDate` / `toDate` (`YYYY-MM-DD`, the names the filter bar
 * writes) bound `submitted_at` as whole calendar days in the tenant's timezone
 * (`tenantDayRangeUtc`). A day that is not a real calendar day is refused (400),
 * never read as "no bound".
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
  type ListByTenantStatusSort,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { isYmd, tenantDayRangeUtc } from '@/lib/tenant-day-range';
import { loadAdminBroadcastQueue, queueSortFor, upcomingFrom } from '@/lib/admin-broadcast-queue';
import { readEblastStageChips } from '@/lib/eblast-waiting-count';

/** URL sort tokens → the repo's orders. `scheduled_for` is the Upcoming sends preset's token. */
const SORT_TOKENS = {
  submitted_at_asc: 'submitted_at_asc',
  submitted_at_desc: 'submitted_at_desc',
  created_at_desc: 'created_at_desc',
  stage_entered_at_asc: 'stage_entered_at_asc',
  stage_entered_at_desc: 'stage_entered_at_desc',
  scheduled_for: 'scheduled_for_asc',
} as const satisfies Record<string, ListByTenantStatusSort>;

const ListQuerySchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return ['submitted'] as BroadcastStatus[];
      const arr = Array.isArray(v) ? v : [v];
      return arr.filter((s) =>
        (BROADCAST_STATUSES as readonly string[]).includes(s),
      ) as BroadcastStatus[];
    }),
  memberId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // UX review H1 — no default token: an absent sort is the view's own order
  // (`queueSortFor`, shared with the page), never one order for every view.
  sort: z
    .enum([
      'submitted_at_asc',
      'submitted_at_desc',
      'created_at_desc',
      'stage_entered_at_asc',
      'stage_entered_at_desc',
      'scheduled_for',
    ])
    .optional(),
  from: z.literal('now').optional(),
  fromDate: z.string().refine(isYmd).optional(),
  toDate: z.string().refine(isYmd).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.read');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const url = new URL(request.url);
  const rawParams: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (rawParams[k] === undefined) {
      rawParams[k] = v;
    } else if (Array.isArray(rawParams[k])) {
      (rawParams[k] as string[]).push(v);
    } else {
      rawParams[k] = [rawParams[k] as string, v];
    }
  }
  const parsed = ListQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    });
  }

  try {
    const scheduledFrom = upcomingFrom(parsed.data.from);
    const submitted = tenantDayRangeUtc(parsed.data.fromDate, parsed.data.toDate, env.tenant.timezone);
    const [page, chips] = await Promise.all([
      loadAdminBroadcastQueue(tenantCtx, {
        statusFilter: parsed.data.status,
        pageSize: parsed.data.limit,
        sort:
          parsed.data.sort !== undefined
            ? SORT_TOKENS[parsed.data.sort]
            : queueSortFor(parsed.data.status, false),
        ...(parsed.data.cursor !== undefined && { cursor: parsed.data.cursor }),
        ...(parsed.data.memberId !== undefined && { memberId: parsed.data.memberId }),
        ...(scheduledFrom !== undefined && { scheduledFrom }),
        ...(submitted.fromInclusive !== undefined && { submittedFrom: submitted.fromInclusive }),
        ...(submitted.toExclusive !== undefined && { submittedBefore: submitted.toExclusive }),
      }),
      readEblastStageChips(tenantCtx, 'M119.api.admin_broadcasts.stage_counts_failed'),
    ]);

    // Pending count (badge)
    const pendingCountRows = await runInTenant(tenantCtx, async (tx) => {
      return (await tx.execute(sql`
        SELECT COUNT(*)::int AS n
        FROM broadcasts
        WHERE tenant_id = ${tenantCtx.slug}
          AND status = 'submitted'
      `)) as unknown as Array<{ n: number }>;
    });
    const totalPending = pendingCountRows[0]?.n ?? 0;

    return NextResponse.json(
      {
        items: page.items,
        nextCursor: page.nextCursor,
        totalPending,
        stageCounts: chips.kind === 'ok' ? chips.counts : null,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.list.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
