/**
 * `/admin/renewals` server component — F8 pipeline dashboard.
 *
 * Orchestrates the pipeline dashboard: server-side data fetch via
 * `loadPipeline` use-case → snake_case URL params parsed → composed
 * UI (filter bar + urgency tabs + table + lapsed panel).
 *
 * Authz: admin OR manager. Manager is read-only — manager mutations are
 * blocked server-side at the route handlers (403 + `f8_role_violation_blocked`
 * audit), not via client-disabled menu items. The pipeline row menu only
 * exposes Send reminder + Open; Cancel + Mark-paid-offline are not row actions
 * at all (they live on the cycle-detail page).
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, the dashboard route
 * returns 404 with audit `renewal_kill_switch_blocked` (FR-052b).
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { renewalsMetrics } from '@/lib/metrics';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import {
  loadPipeline,
  loadPendingReactivationReview,
  makeRenewalsDeps,
  TIER_BUCKETS,
  type TierBucket,
  type UrgencyBucket,
  type LoadPendingReactivationReviewOutput,
} from '@/modules/renewals';
import { RenewalsEmptyState } from './_components/empty-state';
import { UrgencyBucketTabs } from './_components/urgency-bucket-tabs';
import { PipelineTable } from './_components/pipeline-table';
import { LapsedTab } from './_components/lapsed-tab';
import { TierFilterSelect } from './_components/tier-filter-select';
import { ErrorCardActions } from './_components/error-card-actions';
import { AtRiskWidget } from './_components/at-risk-widget';
import { MembersWithoutCycleTray } from './_components/members-without-cycle-tray';
import { RenewalsViewTabs } from './_components/renewals-view-tabs';
import {
  PendingReviewList,
  type PendingReviewRow,
} from './_components/pending-review-list';
import { fetchPendingReviewCompanyNames } from './_lib/pending-review-enrichment';
import { ResultCountAnnouncer } from '@/components/renewals/result-count-announcer';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.renewals');
  return { title: t('title'), description: t('subtitle') };
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
  /** `'pending-review'` selects the reactivation-review discovery view. */
  readonly view?: string;
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
      <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
        <Card>
          <CardContent
            role="status"
            aria-live="polite"
            className="py-12 text-center text-muted-foreground"
          >
            {t('error.featureDisabled')}
          </CardContent>
        </Card>
      </RenewalsPageShell>
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
  const isPendingReviewView = query.view === 'pending-review';

  const deps = makeRenewalsDeps(tenantCtx.slug);

  // 070 F8 item #18 — "Pending review" discovery view. Loaded ONLY when
  // active so the urgency-pipeline hot path (SC-003 p95<500ms) takes no
  // extra query. The admin reaches it via the view-tabs toggle; the
  // approve/reject actions live on the cycle-detail page.
  if (isPendingReviewView) {
    const locale = await getLocale();
    return (
      <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
        <Card>
          <CardContent className="flex flex-col gap-4">
            <RenewalsViewTabs current="pending-review" />
            <PendingReviewSection
              tenantSlug={tenantCtx.slug}
              locale={locale}
            />
          </CardContent>
        </Card>
      </RenewalsPageShell>
    );
  }

  // W0-09: § 23.1.1 lapsed_tab_visit counter — emitted before the data
  // fetch so the visit is recorded even when loadPipeline errors.
  if (urgency === 'lapsed') {
    renewalsMetrics.pipelineLapsedTabVisit(tenantCtx.slug);
  }

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
      <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
        <LoadErrorCard message={t('error.loadFailed')}>
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
        </LoadErrorCard>
      </RenewalsPageShell>
    );
  }

  const { rows, summary, nextCursor } = result.value;

  // Build the "Next 50" URL preserving tier + urgency but replacing the
  // cursor. Matches the `/admin/audit` keyset-pagination pattern.
  const paginationParams = new URLSearchParams();
  if (tier !== undefined) paginationParams.set('tier', tier);
  paginationParams.set('urgency', urgency);
  if (nextCursor !== null) paginationParams.set('cursor', nextCursor);
  const nextHref =
    nextCursor !== null
      ? `/admin/renewals?${paginationParams.toString()}`
      : null;
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
    <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* 070 F8 item #18 — view toggle reachable from the pipeline so
              admins can navigate to the pending-review discovery list.
              The count badge is loaded only on the pending-review view
              (pipeline hot path takes no extra query), so it renders
              without a badge here. */}
          <RenewalsViewTabs current="pipeline" />
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
              {nextHref ? (
                // Keyset cursor pagination: when the repo returns
                // nextCursor != null the page was capped at 50 rows.
                // Render a "Next 50 →" link (same pattern as
                // /admin/audit) + a visible "Showing first 50" hint
                // so all users know the list is truncated. The
                // UrgencyBucketTabs already deletes the cursor param
                // on tab switch (line 63), so stale cursors are
                // auto-cleared on urgency change.
                <div className="flex items-center justify-between gap-4 pt-1">
                  <p className="text-xs text-muted-foreground">
                    {t('table.pagination.showingFirst')}
                  </p>
                  <a
                    href={nextHref}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    {t('table.pagination.next')}
                  </a>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      <AtRiskWidget actorRole={widgetActorRole} />
      {/* DV-18 — read-only "Members without renewal cycle" tray. Best-effort:
          the sub-component catches an infra throw + renders a load-error card,
          so it NEVER crashes the pipeline page. Mounted on the pipeline view
          only (not the pending-review discovery view). */}
      <MembersWithoutCycleTray tenantSlug={tenantCtx.slug} />
    </RenewalsPageShell>
  );
}

/**
 * 070 F8 item #18 — server-rendered "Pending review" discovery section.
 *
 * Loads the cycles in `pending_admin_reactivation` via
 * `loadPendingReactivationReview` then batch-enriches each row's member
 * company name via F3's `findManyByIdsInTx` in a SINGLE tenant-scoped read
 * (`fetchPendingReviewCompanyNames`). This is the pattern the use-case
 * doc-header prescribes; it replaces the prior per-row `fetchMemberDisplay`
 * N+1 (two sequential `runInTenant` queries per cycle whose primary-contact
 * half was fetched then discarded — this list only renders the company
 * name). A member absent from the batch map falls back to the cycle's short
 * id, so a single missing member never blanks the whole list. Dates are
 * formatted day-grain, locale-/BE-aware, on the server so the client list
 * component stays locale-agnostic.
 *
 * Best-effort error handling: an infrastructure throw from the use-case OR
 * the batch enrichment renders a "couldn't load" alert (the pipeline page
 * itself never crashes).
 */
async function PendingReviewSection({
  tenantSlug,
  locale,
}: {
  readonly tenantSlug: string;
  readonly locale: string;
}) {
  const t = await getTranslations('admin.renewals.pendingReview');
  const deps = makeRenewalsDeps(tenantSlug);

  let cycles: LoadPendingReactivationReviewOutput['cycles'];
  // memberId → companyName, resolved in ONE batched member read (no N+1).
  let companyNames: ReadonlyMap<string, string>;
  try {
    const result = await loadPendingReactivationReview(deps, {
      tenantId: tenantSlug,
    });
    // The use-case's error channel is `never` today, so `ok` is always true.
    // If a real error variant is ever added, THROW so the catch below renders
    // the "couldn't load" alert instead of silently showing an EMPTY review
    // list (070 speckit-review errors S-2 — preserve the "never a blank list
    // on error" invariant even if the error channel is later widened).
    if (!result.ok) {
      throw new Error(
        'loadPendingReactivationReview returned an unexpected error',
      );
    }
    cycles = result.value.cycles;

    // Batch-enrich company names in a SINGLE tenant-scoped read. A throw
    // here (RLS reject / connection / timeout) is caught below and renders
    // the same "couldn't load" alert as a cycle-load failure — never a
    // silently blank list.
    companyNames = await fetchPendingReviewCompanyNames({
      tenantSlug,
      memberIds: cycles.map((c) => c.memberId),
    });
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.PENDING_REVIEW_LOAD',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] pending-review load failed',
    );
    return <LoadErrorCard message={t('loadFailed')} />;
  }

  const dtFmtDay = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
  });
  const fmtDateOnly = (s: string | null | undefined): string =>
    s ? dtFmtDay.format(new Date(s)) : '—';

  // A member absent from the batch map (archived / cross-tenant-hidden)
  // degrades to the cycle short-id — same graceful fallback as before, now
  // without a per-row query.
  const rows: PendingReviewRow[] = cycles.map((c) => ({
    cycleId: c.cycleId,
    companyName: companyNames.get(c.memberId) ?? c.cycleId.slice(0, 8),
    pendingSinceLabel: fmtDateOnly(c.enteredPendingAt),
    expiryLabel: fmtDateOnly(c.expiresAt),
  }));

  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('sectionTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('sectionSubtitle')}</p>
      </div>
      <PendingReviewList rows={rows} />
    </>
  );
}

/**
 * Shared page chrome for every `/admin/renewals` return path — the
 * `TableContainer` + `PageHeader` envelope that previously repeated across the
 * feature-disabled, pending-review, load-failed, and main returns (070
 * speckit-review simplify S-2). Children render below the header.
 */
function RenewalsPageShell({
  title,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly children: ReactNode;
}) {
  return (
    <TableContainer>
      <PageHeader title={title} subtitle={subtitle} />
      {children}
    </TableContainer>
  );
}

/**
 * Centered destructive "couldn't load" alert card — shared by the pipeline
 * load-failure and the pending-review load-failure (070 speckit-review
 * simplify S-2). `children` slots optional actions (e.g. retry / go-back)
 * below the message.
 */
function LoadErrorCard({
  message,
  children,
}: {
  readonly message: string;
  readonly children?: ReactNode;
}) {
  return (
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
        <div className="text-base font-medium text-destructive">{message}</div>
        {children}
      </CardContent>
    </Card>
  );
}
