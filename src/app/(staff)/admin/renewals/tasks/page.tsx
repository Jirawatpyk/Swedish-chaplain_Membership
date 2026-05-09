/**
 * F8 Phase 8 T218 — `/admin/renewals/tasks` server component.
 *
 * Manual escalation-task queue per US6. Lists tasks for the current
 * tenant with status filter (default `open`), per-user-tray filter,
 * and overdue-banner header. Reads via `escalationTaskRepo.list`.
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
import { makeRenewalsDeps } from '@/modules/renewals';
import { EscalationTaskQueue } from './_components/escalation-task-queue';
import { TierUpgradeErrorRetry } from '../tier-upgrades/_components/tier-upgrade-error-retry';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.tasks');
  return { title: `${t('title')} · SweCham`, description: t('subtitle') };
}

export default async function EscalationTaskQueuePage() {
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
        statusFilter: ['open'],
        sort: 'due_at_asc',
      },
    );
    queueItems = page.items;

    overdueCount = await deps.escalationTaskRepo.countMatching(
      tenantCtx.slug,
      {
        statusFilter: ['open'],
        overdueOnly: true,
      },
    );
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
              <TierUpgradeErrorRetry
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
