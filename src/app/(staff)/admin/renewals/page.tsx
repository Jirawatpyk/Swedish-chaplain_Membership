/**
 * `/admin/renewals` server component — F8 pipeline dashboard.
 *
 * Orchestrates the pipeline dashboard: server-side data fetch via
 * `loadPipeline` use-case → snake_case URL params parsed → composed
 * UI (filter bar + urgency tabs + table + lapsed panel).
 *
 * Authz: admin OR manager. Manager is read-only — mutating row actions
 * (Send reminder / Cancel / Mark paid offline) render server-side as
 * disabled DropdownMenuItems for managers; the route handlers also
 * emit `f8_role_violation_blocked` audit on any manager-bypass attempt.
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, the dashboard route
 * returns 404 with audit `renewal_kill_switch_blocked` (FR-052b).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { AlertTriangle } from 'lucide-react';
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
import { ErrorCardActions } from './_components/error-card-actions';
import { AtRiskWidget } from './_components/at-risk-widget';
import { ResultCountAnnouncer } from '@/components/renewals/result-count-announcer';

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
          <CardContent
            role="status"
            aria-live="polite"
            className="py-12 text-center text-muted-foreground"
          >
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
    const correlationId = randomUUID();
    logger.error(
      {
        tenantId: tenantCtx.slug,
        error: result.error.kind,
        correlationId,
      },
      'renewals pipeline page: load-pipeline failed',
    );
    return (
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent
            role="alert"
            aria-live="assertive"
            className="flex flex-col items-center gap-4 py-12 text-center"
          >
            <AlertTriangle
              aria-hidden="true"
              className="h-10 w-10 text-destructive"
            />
            <div className="text-base font-medium text-destructive">
              {t('error.loadFailed')}
            </div>
            {/*
              K12-1 (UX-K-3): Retry was a `<Link>` with `?_retry=${id}`
              query-string cache-bust which (a) read as "navigation" to
              AT (WCAG SC 4.1.2) and (b) polluted browser history with
              accumulating retry IDs. ErrorCardActions runs
              `router.refresh()` inside `useTransition` — semantic
              button, no URL mutation, pending state for the in-flight
              RSC re-fetch.
            */}
            <ErrorCardActions
              correlationId={correlationId}
              goBackHref="/admin"
              retryLabel={t('error.retry')}
              pendingLabel={t('error.retrying')}
              retryFailedLabel={t('error.retryFailed')}
              goBackLabel={t('error.goBack')}
              referenceLabel={t('error.referenceLabel')}
            />
          </CardContent>
        </Card>
      </TableContainer>
    );
  }

  const { rows, summary } = result.value;
  // `RenewalsEmptyState` replaces the entire pipeline shell (tabs +
  // filter + table) with a full-card "no renewals due" illustration,
  // so it must only fire when NO filter is active. Otherwise applying
  // a tier that happens to match zero cycles (e.g. `tier=premium`
  // when no premium member is in the renewal window) tears out the
  // tier-filter dropdown itself, trapping the admin in the empty
  // state with no way to clear the filter. When a filter is active
  // and matches nothing, the existing table/lapsed-tab "No members"
  // body-row pattern is the right empty surface.
  const showEmptyState =
    tier === undefined &&
    summary.totalInWindow === 0 &&
    summary.lapsedCount === 0;

  // Phase 6 Wave E (T167) — at-risk widget plugged in alongside the
  // pipeline table. Hidden by route gate when:
  //   - whole-F8 kill-switch is on (early-return branch above)
  //   - granular FEATURE_F8_AT_RISK_DISABLED kill-switch is on (the
  //     widget renders a "feature temporarily unavailable" card per
  //     FR-052b — handled inside the widget via API
  //     `feature_disabled: true` field)
  //   - actor role is `member` — but route already redirects member to
  //     /portal at L77, so this server component only runs for
  //     admin / manager.
  const widgetActorRole: 'admin' | 'manager' =
    currentUser.role === 'manager' ? 'manager' : 'admin';

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
              <ResultCountAnnouncer
                count={rows.length}
                urgencyKey={urgency}
              />
              {urgency === 'lapsed' ? (
                <LapsedTab rows={rows} />
              ) : (
                <PipelineTable rows={rows} />
              )}
            </>
          )}
        </CardContent>
      </Card>
      <AtRiskWidget actorRole={widgetActorRole} />
    </TableContainer>
  );
}
