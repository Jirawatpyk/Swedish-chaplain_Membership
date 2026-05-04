/**
 * F8 Phase 3 Wave H4 · T067 — `/admin/renewals` server component.
 *
 * Orchestrates the pipeline dashboard: server-side data fetch via
 * `loadPipeline` use-case → snake_case URL params parsed → composed
 * UI (filter bar + urgency tabs + table + lapsed panel).
 *
 * Authz: admin OR manager (manager is read-only — no row actions
 * mutating state are exposed here for Phase 3). Kill-switch: when
 * `FEATURE_F8_RENEWALS=false`, the page shows a generic "feature
 * unavailable" placeholder rather than crashing.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { Card, CardContent } from '@/components/ui/card';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  loadPipeline,
  makeRenewalsDeps,
  TIER_BUCKETS,
  type TierBucket,
  type UrgencyBucket,
} from '@/modules/renewals';
import { RenewalsEmptyState } from './_components/empty-state';
import { UrgencyBucketTabs } from './_components/urgency-bucket-tabs';
import { PipelineTable } from './_components/pipeline-table';
import { LapsedTab } from './_components/lapsed-tab';
import { TierFilterSelect } from './_components/tier-filter-select';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals');
  return { title: `${t('title')} · SweCham`, description: t('subtitle') };
}

const URGENCY_VALUES: ReadonlySet<UrgencyBucket> = new Set([
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'grace',
  'lapsed',
]);

const DEFAULT_URGENCY: UrgencyBucket = 't-30';

interface SearchParams {
  readonly tier?: string;
  readonly urgency?: string;
  readonly cursor?: string;
}

export default async function RenewalsPipelinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const t = await getTranslations('admin.renewals');

  // Auth + role check — managers permitted on this read-only surface.
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin' && currentUser.role !== 'manager') {
    redirect('/portal');
  }

  if (!env.features.f8Renewals) {
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t('error.featureDisabled')}
          </CardContent>
        </Card>
      </TableContainer>
    );
  }

  const query = await searchParams;
  const reqHeaders = await headers();
  const fakeRequest = new Request(
    `http://${reqHeaders.get('host') ?? 'localhost'}/admin/renewals`,
    { headers: reqHeaders },
  );
  const tenantCtx = resolveTenantFromRequest(fakeRequest);

  const tier =
    query.tier && (TIER_BUCKETS as readonly string[]).includes(query.tier)
      ? (query.tier as TierBucket)
      : undefined;
  const urgency =
    query.urgency && URGENCY_VALUES.has(query.urgency as UrgencyBucket)
      ? (query.urgency as UrgencyBucket)
      : DEFAULT_URGENCY;
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;

  const deps = makeRenewalsDeps(tenantCtx.slug);
  const result = await loadPipeline(deps, {
    tenantId: tenantCtx.slug,
    ...(tier !== undefined ? { tier } : {}),
    urgency,
    ...(cursor !== undefined ? { cursor } : {}),
    limit: 50,
  });

  if (!result.ok) {
    logger.error(
      { tenantId: tenantCtx.slug, error: result.error.kind },
      'renewals pipeline page: load-pipeline failed',
    );
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="py-12 text-center text-destructive">
            {t('error.loadFailed')}
          </CardContent>
        </Card>
      </TableContainer>
    );
  }

  const { rows, summary } = result.value;
  const showEmptyState =
    summary.totalInWindow === 0 && summary.lapsedCount === 0;

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {showEmptyState ? (
            <RenewalsEmptyState />
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <UrgencyBucketTabs
                  current={urgency}
                  counts={summary.byUrgency}
                  lapsedCount={summary.lapsedCount}
                />
                <TierFilterSelect current={tier ?? 'all'} />
              </div>
              {urgency === 'lapsed' ? (
                <LapsedTab rows={rows} />
              ) : (
                <PipelineTable rows={rows} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </TableContainer>
  );
}
