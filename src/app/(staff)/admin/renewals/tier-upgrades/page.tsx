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
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
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
  let hasError = false;
  try {
    const queue = await deps.tierUpgradeRepo.listForAdminQueue(
      tenantCtx.slug,
      { limit: 50 },
    );
    queueItems = queue.items;
  } catch (e) {
    // Phase 7 review-fix I-UX-1: render explicit error state instead of
    // silently rendering empty-state copy (which would mislead admin
    // into thinking no candidates exist when the DB query failed).
    hasError = true;
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)) },
      'admin.renewals.tier-upgrades.page_load_failed',
    );
  }

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {hasError ? (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardContent className="flex items-start gap-3 py-6">
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div>
              <p className="text-base font-medium text-destructive">
                {t('error_state.title')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('error_state.subtitle')}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
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
      )}
    </TableContainer>
  );
}
