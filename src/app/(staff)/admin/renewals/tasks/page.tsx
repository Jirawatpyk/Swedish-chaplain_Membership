/**
 * F8 Phase 8 T218 — `/admin/renewals/tasks` server component.
 *
 * Manual escalation-task queue per US6. Lists tasks for the current
 * tenant with status filter (Open/Done/Skipped), per-user-tray filter,
 * task-type filter, overdue-only toggle, and overdue-banner header.
 *
 * Reads via `escalationTaskRepo.listForAdminQueue` (E1 close — JOINs
 * `members` + `membership_plans` + `renewal_cycles` so the AS1
 * member-name + tier + expiry fields land alongside each task row in
 * a single round-trip, no N+1).
 *
 * Filters are passed through `searchParams` (Round 5 C-1 close —
 * previously hardcoded `statusFilter: ['open']` ignored Done/Skipped
 * tabs). The whitelisting + UUID-shape guards mirror the GET API at
 * `/api/admin/renewals/tasks/route.ts`.
 *
 * Authz: admin + manager allowed (read). The mutating actions (Done /
 * Skip / Reassign) inside `<EscalationTaskQueue />` are admin-only and
 * the API routes enforce that — manager sees the tasks read-only.
 *
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, returns 404.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  ESCALATION_UNASSIGNED_FILTER,
  makeRenewalsDeps,
  type EscalationTaskStatus,
} from '@/modules/renewals';
import { EscalationTaskQueue } from './_components/escalation-task-queue';
import { RenewalsErrorRetry } from '../_components/renewals-error-retry';

const VALID_STATUSES = new Set(['open', 'done', 'skipped'] as const);
const VALID_ASSIGNMENTS = new Set(['all', 'mine', 'unassigned'] as const);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickStatus(raw: string | undefined): EscalationTaskStatus {
  return raw !== undefined && VALID_STATUSES.has(raw as EscalationTaskStatus)
    ? (raw as EscalationTaskStatus)
    : 'open';
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.tasks');
  return { title: `${t('title')} · SweCham`, description: t('subtitle') };
}

export default async function EscalationTaskQueuePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!env.features.f8Renewals) {
    notFound();
  }

  const session = await requireSession('staff');
  const role = session.user.role;
  if (role !== 'admin' && role !== 'manager') {
    redirect('/admin/renewals');
  }

  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/renewals/tasks`,
    { headers: reqHeaders },
  );
  const tenantCtx = resolveTenantFromRequest(fakeRequest);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const t = await getTranslations('admin.renewals.tasks');

  // Round 5 C-1 close — pull filter state from URL searchParams so
  // Done / Skipped status tabs + assignment chips + task-type select
  // + overdue toggle survive a page navigation. Whitelist + UUID-
  // shape guard mirrors the GET API helper.
  const sp = (await searchParams) ?? {};
  const pickFirst = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;
  const status = pickStatus(pickFirst(sp['status']));
  const assignmentRaw = pickFirst(sp['assignment']);
  const assignment =
    assignmentRaw !== undefined &&
    VALID_ASSIGNMENTS.has(assignmentRaw as 'all' | 'mine' | 'unassigned')
      ? (assignmentRaw as 'all' | 'mine' | 'unassigned')
      : 'all';
  const taskTypeFilter = pickFirst(sp['task_type']) ?? '';
  const overdueRaw = pickFirst(sp['overdue_only']);
  const overdueOnly = overdueRaw === 'true' || overdueRaw === '1';

  let assignedToUserIdFilter: string | undefined;
  if (assignment === 'mine') {
    assignedToUserIdFilter = session.user.id;
  } else if (assignment === 'unassigned') {
    assignedToUserIdFilter = ESCALATION_UNASSIGNED_FILTER;
  } else {
    // Allow direct UUID via ?assignment=<uuid> for sharing a colleague's
    // tray (defence-in-depth: only accept on UUID shape).
    if (assignmentRaw !== undefined && UUID_RE.test(assignmentRaw)) {
      assignedToUserIdFilter = assignmentRaw;
    }
  }

  let queueItems: Awaited<
    ReturnType<typeof deps.escalationTaskRepo.listForAdminQueue>
  >['items'] = [];
  let overdueCount = 0;
  let hasError = false;

  try {
    // E1 close — `listForAdminQueue` JOINs members + renewal_cycles +
    // membership_plans so the AS1-mandated member-name + tier + expiry
    // fields land alongside the task row without an N+1 lookup.
    const page = await deps.escalationTaskRepo.listForAdminQueue(
      tenantCtx.slug,
      {
        pageSize: 50,
        statusFilter: [status],
        ...(assignedToUserIdFilter !== undefined
          ? { assignedToUserIdFilter }
          : {}),
        ...(overdueOnly ? { overdueOnly: true } : {}),
        sort: 'due_at_asc',
      },
    );
    // Task-type filter applied client-side after fetch (pageSize 50;
    // small enough to filter in-memory without a repo signature change).
    queueItems = taskTypeFilter
      ? page.items.filter((task) => task.taskType === taskTypeFilter)
      : page.items;

    // Overdue banner only meaningful when status='open' and we're not
    // already filtered to overdue-only.
    if (status === 'open' && !overdueOnly) {
      overdueCount = await deps.escalationTaskRepo.countMatching(
        tenantCtx.slug,
        {
          statusFilter: ['open'],
          overdueOnly: true,
        },
      );
    }
  } catch (e) {
    hasError = true;
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      'admin.renewals.tasks.page_load_failed',
    );
  }

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {hasError ? (
        <Card
          className="border-destructive/40 bg-destructive/5"
          role="alert"
        >
          <CardContent className="flex items-start gap-3 py-6">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="flex-1">
              <p className="text-base font-medium text-destructive">
                {t('error_state.title')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('error_state.subtitle')}
              </p>
              <RenewalsErrorRetry
                label={t('error_state.retry')}
                retryingLabel={t('error_state.retrying')}
              />
            </div>
          </CardContent>
        </Card>
      ) : (
        <EscalationTaskQueue
          actorRole={role}
          actorUserId={session.user.id}
          overdueCount={overdueCount}
          items={queueItems.map((task) => ({
            taskId: task.taskId,
            memberId: task.memberId,
            memberCompanyName: task.memberCompanyName,
            memberTierBucket: task.memberTierBucket,
            cycleId: task.cycleId,
            cycleExpiresAt: task.cycleExpiresAt,
            taskType: task.taskType,
            assignedToRole: task.assignedToRole,
            assignedToUserId: task.assignedToUserId,
            dueAt: task.dueAt,
            status: task.status,
            createdAt: task.createdAt,
          }))}
        />
      )}
    </TableContainer>
  );
}
