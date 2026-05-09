/**
 * F8 Phase 8 T214 — `GET /api/admin/renewals/tasks`.
 *
 * Returns the admin escalation-task queue for the current tenant +
 * an `overdue_count` for the queue-top "X overdue tasks" banner
 * (FR-045).
 *
 * Round 5 I-3 close — switched from bare `repo.list` to
 * `repo.listForAdminQueue` so the AS1-mandated member name + tier
 * bucket + cycle expiry + assignee display name fields appear in the
 * response shape (`member_company_name`, `member_tier_bucket`,
 * `cycle_expires_at`, `assigned_to_display_name`). Contract tests +
 * future external consumers receive the same enriched shape the UI
 * uses internally via SSR.
 *
 * Filters (query params):
 *   - `status` — `'open' | 'done' | 'skipped'`. Default `'open'`.
 *   - `assigned_to_user_id` — `'me' | UUID | 'unassigned'`. `'me'`
 *     resolves to the calling admin's user id. `'unassigned'` matches
 *     rows where `assigned_to_user_id IS NULL`.
 *   - `task_type` — exact-match string filter (e.g. `'phone_call'`).
 *   - `overdue_only` — `'true'` to filter rows where `due_at < now()`.
 *   - `limit` — 1..100, default 50. `cursor` — opaque string from a
 *     prior page's `next_cursor`.
 *
 * RBAC: `read` (admin + manager allowed; member denied at middleware).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import {
  ESCALATION_UNASSIGNED_FILTER,
  InvalidCursorError,
  makeRenewalsDeps,
} from '@/modules/renewals';

const VALID_STATUSES = new Set(['open', 'done', 'skipped'] as const);
type StatusFilter = 'open' | 'done' | 'skipped';

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'read');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const url = new URL(request.url);

  // ----- Query-param parse -----
  const limitParam = url.searchParams.get('limit');
  const cursorParam = url.searchParams.get('cursor');
  const statusParam = url.searchParams.get('status');
  const assignedParam = url.searchParams.get('assigned_to_user_id');
  const taskTypeParam = url.searchParams.get('task_type');
  const overdueParam = url.searchParams.get('overdue_only');

  const parsedLimit =
    limitParam !== null ? Number.parseInt(limitParam, 10) : 50;
  const limit =
    Number.isFinite(parsedLimit) &&
    parsedLimit >= 1 &&
    parsedLimit <= 100
      ? parsedLimit
      : 50;

  const status: StatusFilter =
    statusParam !== null && VALID_STATUSES.has(statusParam as StatusFilter)
      ? (statusParam as StatusFilter)
      : 'open';

  let assignedToUserIdFilter: string | undefined;
  if (assignedParam !== null) {
    if (assignedParam === 'me') {
      assignedToUserIdFilter = ctx.current.user.id;
    } else if (assignedParam === 'unassigned') {
      assignedToUserIdFilter = ESCALATION_UNASSIGNED_FILTER;
    } else {
      // Validate UUID — reject anything else (defence-in-depth).
      const UUID_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (UUID_RE.test(assignedParam)) {
        assignedToUserIdFilter = assignedParam;
      } else {
        return errorResponse({
          status: 400,
          code: 'invalid_assigned_to_user_id',
          correlationId: ctx.correlationId,
        });
      }
    }
  }

  const overdueOnly = overdueParam === 'true' || overdueParam === '1';

  try {
    const page = await deps.escalationTaskRepo.listForAdminQueue(
      tenantCtx.slug,
      {
        pageSize: limit,
        ...(cursorParam !== null ? { cursor: cursorParam } : {}),
        statusFilter: [status],
        ...(assignedToUserIdFilter !== undefined
          ? { assignedToUserIdFilter }
          : {}),
        ...(overdueOnly ? { overdueOnly: true } : {}),
        sort: 'due_at_asc',
      },
    );

    // Filter by task_type in the result set (small page; no need for a
    // dedicated repo arg). Future Phase 9+ optimisation can push the
    // filter into the repo signature for stable cursor pagination.
    const items =
      taskTypeParam !== null && taskTypeParam.length > 0
        ? page.items.filter((t) => t.taskType === taskTypeParam)
        : page.items;

    // Overdue count for the queue-top banner (FR-045). Only meaningful
    // when status='open'; closed tabs don't display the banner.
    let overdueCount = 0;
    if (status === 'open' && !overdueOnly) {
      overdueCount = await deps.escalationTaskRepo.countMatching(
        tenantCtx.slug,
        {
          statusFilter: ['open'],
          overdueOnly: true,
        },
      );
    }

    return successResponse(
      {
        items: items.map((t) => ({
          task_id: t.taskId,
          member_id: t.memberId,
          member_company_name: t.memberCompanyName,
          member_tier_bucket: t.memberTierBucket,
          cycle_id: t.cycleId,
          cycle_expires_at: t.cycleExpiresAt,
          task_type: t.taskType,
          assigned_to_role: t.assignedToRole,
          assigned_to_user_id: t.assignedToUserId,
          assigned_to_display_name: t.assignedToDisplayName,
          assigned_to_email: t.assignedToEmail,
          due_at: t.dueAt,
          status: t.status,
          related_suggestion_id: t.relatedSuggestionId,
          created_at: t.createdAt,
          closed_at: t.closedAt,
          outcome_note: t.outcomeNote,
          skipped_reason: t.skippedReason,
        })),
        next_cursor: page.nextCursor,
        overdue_count: overdueCount,
      },
      ctx.correlationId,
    );
  } catch (e) {
    // Round 5 I-7 close — surface bad-cursor as 400, not 500.
    if (e instanceof InvalidCursorError) {
      return errorResponse({
        status: 400,
        code: 'invalid_cursor',
        correlationId: ctx.correlationId,
      });
    }
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
      },
      'admin.renewals.tasks.list_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
