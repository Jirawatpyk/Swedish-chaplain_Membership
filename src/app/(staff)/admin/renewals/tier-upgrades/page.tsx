/**
 * F8 Phase 7 T197 — `/admin/renewals/tier-upgrades` server component.
 *
 * Tier-upgrade admin queue page. Lists `open` + `accepted_pending_apply`
 * suggestions for the current tenant. Admin role required.
 *
 * Authz: admin only. Manager + member redirect to /admin/renewals
 * (the queue is admin-only per FR-052a).
 *
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, returns 404.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { makeRenewalsDeps } from '@/modules/renewals';
import { TierUpgradeQueueClient } from './_components/tier-upgrade-queue';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  return { title: `${t('title')} · SweCham`, description: t('subtitle') };
}

export default async function TierUpgradeQueuePage() {
  if (!env.features.f8Renewals) {
    notFound();
  }

  const session = await requireSession('staff');
  if (session.user.role !== 'admin') {
    redirect('/admin/renewals');
  }

  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/renewals/tier-upgrades`,
    { headers: reqHeaders },
  );
  const tenantCtx = resolveTenantFromRequest(fakeRequest);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const t = await getTranslations('admin.renewals.tier_upgrades');

  let queueItems: Awaited<
    ReturnType<typeof deps.tierUpgradeRepo.listForAdminQueue>
  >['items'] = [];
  try {
    const queue = await deps.tierUpgradeRepo.listForAdminQueue(
      tenantCtx.slug,
      { limit: 50 },
    );
    queueItems = queue.items;
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      'admin.renewals.tier-upgrades.page_load_failed',
    );
  }

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <TierUpgradeQueueClient
        items={queueItems.map((s) => ({
          suggestionId: s.suggestionId,
          memberId: s.memberId,
          status: s.status,
          fromPlanId: s.fromPlanId,
          toPlanId: s.toPlanId,
          reasonCode: s.reasonCode,
          createdAt: s.createdAt,
        }))}
      />
    </TableContainer>
  );
}
