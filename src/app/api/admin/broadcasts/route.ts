/**
 * T108 — GET `/api/admin/broadcasts`.
 *
 * Admin review queue list. Supports server-side filter (status, member,
 * segment, date range) + sort + cursor pagination via the existing
 * `BroadcastsRepo.listByTenantStatus` method.
 *
 * Authz: admin OR manager (manager is read-only on this surface per Q12
 * spec § 2.1). Member display-name enrichment via raw SQL LEFT JOIN
 * inline; both `broadcasts` + `members` tables are tenant-scoped via
 * RLS so `runInTenant` keeps the JOIN scoped.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
  makeGetBroadcastDeps,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const ListQuerySchema = z.object({
  status: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v === undefined) return ['submitted'];
      const arr = Array.isArray(v) ? v : [v];
      return arr.filter((s) =>
        (BROADCAST_STATUSES as readonly string[]).includes(s),
      ) as BroadcastStatus[];
    }),
  memberId: z.string().uuid().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  sort: z
    .enum(['submitted_at_asc', 'submitted_at_desc', 'created_at_desc'])
    .default('submitted_at_asc'),
});

interface QueueItem {
  readonly broadcastId: string;
  readonly status: BroadcastStatus;
  readonly subject: string;
  readonly requestedByMemberId: string;
  readonly requestedByMemberDisplayName: string;
  readonly actorRole: string;
  readonly segmentType: string;
  readonly estimatedRecipientCount: number;
  readonly submittedAt: string | null;
  readonly createdAt: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'read',
  });
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

  const deps = makeGetBroadcastDeps(tenantCtx.slug);
  try {
    const result = await deps.broadcastsRepo.listByTenantStatus(
      tenantCtx.slug,
      {
        ...(parsed.data.cursor !== undefined && { cursor: parsed.data.cursor }),
        pageSize: parsed.data.limit,
        ...(parsed.data.status.length > 0 && {
          statusFilter: parsed.data.status as ReadonlyArray<BroadcastStatus>,
        }),
        ...(parsed.data.memberId !== undefined && {
          memberIdFilter: parsed.data.memberId,
        }),
        sort: parsed.data.sort,
      },
    );

    // Member display-name enrichment via single LEFT JOIN
    const memberIds = Array.from(
      new Set(result.rows.map((r) => r.requestedByMemberId)),
    );
    const memberDisplayMap = new Map<string, string>();
    if (memberIds.length > 0) {
      const memberRows = await runInTenant(tenantCtx, async (tx) => {
        return (await tx.execute(sql`
          SELECT member_id, company_name FROM members
          WHERE tenant_id = ${tenantCtx.slug}
            AND member_id::text = ANY(ARRAY[${sql.join(
              memberIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[])
        `)) as unknown as Array<{ member_id: string; company_name: string }>;
      });
      for (const row of memberRows) {
        memberDisplayMap.set(row.member_id, row.company_name);
      }
    }

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

    const items: ReadonlyArray<QueueItem> = result.rows.map((row) => ({
      broadcastId: row.broadcastId as string,
      status: row.status,
      subject: row.subject,
      requestedByMemberId: row.requestedByMemberId,
      requestedByMemberDisplayName:
        memberDisplayMap.get(row.requestedByMemberId) ?? row.requestedByMemberId,
      actorRole: row.actorRole,
      segmentType: row.segmentType,
      estimatedRecipientCount: row.estimatedRecipientCount,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    return NextResponse.json(
      {
        items,
        nextCursor: result.nextCursor,
        totalPending,
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
