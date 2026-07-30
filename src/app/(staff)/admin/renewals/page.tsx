/**
 * `/admin/renewals` server component — F8 pipeline dashboard.
 *
 * Orchestrates the pipeline dashboard: server-side data fetch via
 * `loadPipeline` use-case → snake_case URL params parsed → composed
 * UI (filter bar + urgency tabs + table + lapsed panel).
 *
 * Authz: admin OR manager. Manager is read-only — manager mutations are
 * blocked server-side at the route handlers (403 + `f8_role_violation_blocked`
 * audit) AND (fix round 3) hidden client-side via `canMutate` on
 * `<PipelineTable>`: "Send reminder" and "Mark paid offline" (Task 5, opens
 * the guarded `MarkPaidOfflineDialog`) are admin-only affordances — a manager
 * would otherwise see a CTA that only 403s on submit. "Mark contacted" stays
 * visible for both roles (FR-033 + FR-052a's manager-mutation exception,
 * never 403s for manager — see `pipeline-table.tsx`'s docstring). Cancel is
 * still NOT a row action — it lives only on the cycle-detail page.
 * Kill-switch: when `FEATURE_F8_RENEWALS=false`, the dashboard route
 * returns 404 with audit `renewal_kill_switch_blocked` (FR-052b).
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
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
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import {
  loadPipeline,
  loadPipelineMoney,
  loadPendingReactivationReview,
  makeRenewalsDeps,
  parseMonthParam,
  addMonthsToYm,
  bkkYearMonth,
  TIER_BUCKETS,
  type TierBucket,
  type UrgencyBucket,
  type PipelineSort,
  type LoadPendingReactivationReviewOutput,
  type PipelineMoneySummary,
} from '@/modules/renewals';
import { formatMonthKeyLabel } from '@/components/renewals/month-bucket-label';
import {
  RenewalsByMonthSection,
  RenewalsByMonthSectionSkeleton,
} from './_components/renewals-by-month-section';
import { RenewalsEmptyState } from './_components/empty-state';
import { SuspendedBridgeStrip } from './_components/suspended-bridge-strip';
import { shouldShowRenewalsEmptyState } from './_lib/should-show-empty-state';
import { UrgencyBucketTabs } from './_components/urgency-bucket-tabs';
import {
  PipelineMoneyBand,
  PipelineMoneyBandSkeleton,
} from './_components/pipeline-money-band';
import { PipelineWithBulk } from './_components/pipeline-with-bulk';
import { LoadErrorCard } from './_components/load-error-card';
import { LapsedTab } from './_components/lapsed-tab';
import { TierFilterSelect } from './_components/tier-filter-select';
import { ErrorCardActions } from './_components/error-card-actions';
import { AtRiskWidget } from './_components/at-risk-widget';
import { WorkQueueTabs } from './_components/work-queue-tabs';
import {
  MembersWithoutCycleTray,
  MembersWithoutCycleTraySkeleton,
} from './_components/members-without-cycle-tray';
import {
  RenewalsSectionTabs,
  TabCountBadge,
} from './_components/renewals-section-tabs';
import {
  PendingReviewList,
  type PendingReviewRow,
} from './_components/pending-review-list';
import { fetchPendingReviewCompanyNames } from './_lib/pending-review-enrichment';
import { countOpenPendingReviewCycles } from './_lib/pending-review-open-count';
import { ResultCountAnnouncer } from '@/components/renewals/result-count-announcer';
import { ResultCountLabel } from '@/components/renewals/result-count-label';

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
  'suspended',
  'terminated',
]);

const DEFAULT_URGENCY: UrgencyBucket = 't-30';

const SORT_VALUES: ReadonlySet<PipelineSort> = new Set([
  'expires_at_asc',
  'expires_at_desc',
  'tier_asc',
  'tier_desc',
]);

const DEFAULT_SORT: PipelineSort = 'expires_at_asc';

interface SearchParams {
  readonly tier?: string;
  readonly urgency?: string;
  readonly cursor?: string;
  /** Task 8 — additive server-side sort (`expires`/`tier`, both directions). */
  readonly sort?: string;
  /** `'pending-review'` selects the reactivation-review discovery view. */
  readonly view?: string;
  /** Renewals-by-month lens — `'overdue' | 'YYYY-MM' | 'later'`. */
  readonly month?: string;
  /**
   * #6 fix-wave — instant carried across a month-lens "Next 50" pagination
   * session so the overdue/later bounds don't drift mid-pagination (see
   * the `nowIso` computation below).
   */
  readonly nowIso?: string;
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
  // Task 8 — additive sort. Invalid/absent falls back to the pre-existing
  // `expires_at_asc` (so a bookmarked / hand-edited `?sort` never 400s or
  // mis-pages). Purely additive: `?urgency`/`?month`/`?tier`/`?view` are
  // untouched.
  const sort: PipelineSort =
    query.sort && SORT_VALUES.has(query.sort as PipelineSort)
      ? (query.sort as PipelineSort)
      : DEFAULT_SORT;
  const isPendingReviewView = query.view === 'pending-review';

  // Renewals-by-month lens. A present + VALID month wins over urgency
  // (mutually-exclusive). `nowIso` anchors BOTH the chart aggregation and the
  // pipeline month bounds — computed ONCE so they reconcile exactly.
  //
  // #6 fix-wave — prefer a `nowIso` carried in the URL over minting a fresh
  // instant, but ONLY mid-pagination. Without this, a month bucket with >50
  // rows that straddles a BKK month rollover would recompute `overdue`/`later`
  // bounds on "Next 50" and could miss/dup rows across the session.
  //
  // CRITICAL fix (wave-1 review): the app emits `nowIso` ONLY alongside
  // `cursor` (on a month-lens "Next 50" link), so the read is GATED on
  // `cursor` being present. This closes a param-leak: sibling nav builders
  // (tab / tier / month bar / ✕ chip) all delete `cursor`, so any of them
  // drops the guard back to a fresh `new Date()` — `nowIso` can never ride
  // along inert and silently FREEZE the chart's overdue/later boundaries at
  // a stale T0 for the rest of the session. Belt-and-suspenders with the
  // `next.delete('nowIso')` added to those four nav builders. A stale
  // bookmarked `?nowIso&cursor` safe-degrades (validated by `Date.parse`).
  const nowIso =
    typeof query.nowIso === 'string' &&
    typeof query.cursor === 'string' &&
    !Number.isNaN(Date.parse(query.nowIso))
      ? query.nowIso
      : new Date().toISOString();
  const month = parseMonthParam(query.month);
  const monthLensActive = month !== null;

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
            <RenewalsSectionTabs showPipelineHelp />
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
  // fetch so the visit is recorded even when loadPipeline errors. The URL
  // bucket is now 'terminated' (renamed from 'lapsed'); the metric name is
  // retained (it keys on the same status='lapsed' tab semantics) to avoid
  // dashboard churn — only the user-facing bucket vocabulary changed.
  if (urgency === 'terminated') {
    renewalsMetrics.pipelineLapsedTabVisit(tenantCtx.slug);
  }

  const result = await loadPipeline(deps, {
    tenantId: tenantCtx.slug,
    ...(tier !== undefined ? { tier } : {}),
    urgency,
    ...(monthLensActive ? { month: month as string, nowIso } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    sort,
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

  // Build the "Next 50" URL preserving tier + the active lens (month wins over
  // urgency) but replacing the cursor. Matches the `/admin/audit`
  // keyset-pagination pattern.
  const paginationParams = new URLSearchParams();
  if (tier !== undefined) paginationParams.set('tier', tier);
  if (monthLensActive) {
    paginationParams.set('month', month as string);
    // #6 fix-wave — carry the anchor instant so a "Next 50" continuation
    // reuses the SAME overdue/later bounds as the first page instead of
    // recomputing them against a fresh `new Date()`.
    paginationParams.set('nowIso', nowIso);
  } else {
    paginationParams.set('urgency', urgency);
  }
  // Task 8 — CRITICAL: carry the active sort across "Next 50" so page 2
  // decodes the sort-aware keyset cursor under the SAME sort it was minted
  // under. Without this, page 2 would revert to `expires_at_asc` while the
  // cursor encodes a tier/desc key → dup/skip. Omitted when default so the
  // pre-Task-8 URL shape is unchanged.
  if (sort !== DEFAULT_SORT) paginationParams.set('sort', sort);
  if (nextCursor !== null) paginationParams.set('cursor', nextCursor);
  const nextHref =
    nextCursor !== null
      ? `/admin/renewals?${paginationParams.toString()}`
      : null;

  // Task 8 — header sort links. Same param-preservation discipline as
  // `paginationParams` (preserve tier + the active lens) but ALWAYS reset
  // pagination: DELETE `cursor` (and its `nowIso` companion — never set here)
  // on a sort change so a stale keyset cursor from the previous sort can never
  // mis-page the newly-sorted list. Each column link toggles its own direction.
  const buildSortHref = (nextSort: PipelineSort): string => {
    const p = new URLSearchParams();
    if (tier !== undefined) p.set('tier', tier);
    if (monthLensActive) {
      p.set('month', month as string);
    } else {
      p.set('urgency', urgency);
    }
    p.set('sort', nextSort);
    return `/admin/renewals?${p.toString()}`;
  };
  const sortHrefs: Record<'expires' | 'tier', string> = {
    expires: buildSortHref(
      sort === 'expires_at_asc' ? 'expires_at_desc' : 'expires_at_asc',
    ),
    tier: buildSortHref(sort === 'tier_asc' ? 'tier_desc' : 'tier_asc'),
  };

  // Renewals-by-month lens — dedicated-copy fix-wave-2 #4: `monthKind`
  // discriminates overdue / later / a concrete month so the table empty
  // copy, SR announcer, and filter chip can select grammatical dedicated
  // strings instead of composing the bucket label into a "Renewing in …"
  // month frame (which produced "Renewing in Overdue"). `monthLabel` is now
  // the BARE month text (no frame): `overdue` needs none, `later` uses the
  // same BKK+12 start-key as the chart section (so both surfaces read
  // identically), `month` is the localized month+year.
  const locale = await getLocale();
  const monthKind: 'overdue' | 'later' | 'month' | undefined =
    month === null
      ? undefined
      : month === 'overdue'
        ? 'overdue'
        : month === 'later'
          ? 'later'
          : 'month';
  const monthLabel =
    monthKind === undefined || monthKind === 'overdue'
      ? undefined
      : monthKind === 'later'
        ? formatMonthKeyLabel(addMonthsToYm(bkkYearMonth(nowIso), 12), locale)
        : formatMonthKeyLabel(month as string, locale);
  // `RenewalsEmptyState` replaces the entire pipeline shell (tabs +
  // filter + table) with a full-card "no renewals due" illustration,
  // so it must only fire when NO filter is active. A tier filter OR the
  // renewals-by-month lens each count as an active filter — with either
  // on, an empty result belongs in the table body ("No members renew in
  // {month}" / bucket copy), never the full-card illustration (which
  // tears out the filter controls, trapping the admin). See
  // `shouldShowRenewalsEmptyState` for the pinned predicate.
  const showEmptyState = shouldShowRenewalsEmptyState({
    monthLensActive,
    tierSelected: tier !== undefined,
    totalInWindow: summary.totalInWindow,
    lapsedCount: summary.lapsedCount,
  });

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

  // Fix round 3 (manager money-CTA gating) — threaded into `<PipelineTable>`
  // to hide the admin-only row mutation affordances ("Send reminder" /
  // "Mark paid") from a read-only manager. Server-side 403 guards on those
  // routes stay in place as defence-in-depth; this only fixes the client
  // affordance so a manager never sees a CTA that would just 403.
  const canMutate = currentUser.role === 'admin';

  // Sighted result-count (aria-hidden twin of `ResultCountAnnouncer`). Computed
  // once so the same element can be the LEFT item of the pipeline table's
  // toolbar row (see `PipelineTable resultCount`) and the standalone caption
  // above the terminated `LapsedTab` (which has no toolbar of its own).
  const resultCountLabel = (
    <ResultCountLabel
      count={rows.length}
      {...(monthLensActive
        ? {
            monthKind: monthKind as 'overdue' | 'later' | 'month',
            ...(monthLabel !== undefined ? { monthLabel } : {}),
          }
        : { urgencyKey: urgency })}
    />
  );

  return (
    <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
      {/* DV-Wave2 ⑥ — THB money KPI band. Best-effort Suspense island: it
          streams in independently of the pipeline table and a load throw
          degrades it to nothing (never crashes the pipeline). Reuses the
          already-computed `nowIso` so its FY/BKK boundaries reconcile with the
          month lens. Fix round 1 #1 — the fallback was `null`, so the band
          appearing pushed the whole pipeline card down (a real CLS hit);
          `PipelineMoneyBandSkeleton` reserves the identical footprint. */}
      <Suspense fallback={<PipelineMoneyBandSkeleton />}>
        <PipelineMoneyBandSection tenantSlug={tenantCtx.slug} nowIso={nowIso} />
      </Suspense>
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* 070 F8 item #18 (extended, nav-orphans follow-up) — section
              nav reachable from the pipeline so admins can navigate to
              the pending-review discovery list, plus Tasks and Tier
              upgrades. Item ④ (plan-wide decision) — each tab's pending-
              work count is streamed in a Suspense island (reusing the
              EXISTING loadPendingReactivationReview use-case +
              escalationTaskRepo.countMatching + tierUpgradeRepo.
              listForAdminQueue — zero new queries) so the urgency-
              pipeline hot path stays query-free; the fallback renders
              the identical tab strip with NO badges (CLS-safe — only the
              badges appear once resolved). Best-effort per count: a load
              throw degrades that ONE badge to hidden rather than
              blanking all three. */}
          <Suspense fallback={<RenewalsSectionTabs showPipelineHelp />}>
            <PipelineSectionTabsWithCount tenantSlug={tenantCtx.slug} />
          </Suspense>
          {/* Wave 2 Task 7 — the pipeline body + `AtRiskWidget` are now the
              two lenses of ONE `WorkQueueTabs` control (below the section
              tabs above) instead of two stacked cards. `pipeline` carries
              the SAME filter-row/urgency-tabs/table/pagination block that
              used to render directly here; `needsAction` mounts the
              unchanged `AtRiskWidget` — its own nested 3-band tablist is
              preserved intact (a valid nested-tablist per WAI-ARIA). Pure
              client state (no URL param), so the `admin-pipeline-route` /
              `renewal-pipeline-dashboard` / `renewal-i18n` contracts are
              untouched. */}
          <WorkQueueTabs
            pipeline={
              showEmptyState ? (
                // A2 — the empty state must not swallow the suspended
                // bridge: the launch-shaped tenant (every member a
                // first-bill collection case outside the window) hits
                // exactly this branch.
                <RenewalsEmptyState
                  // A3 — tenant-global pair (NOT the tier-sliced badge):
                  // the bridge reconciles against the Members page's
                  // global Suspended number.
                  suspendedInWindowCount={summary.suspendedInWindowGlobalCount}
                  suspendedOutsideWindowCount={
                    summary.suspendedOutsideWindowCount
                  }
                />
              ) : (
                // Table-caption layout — the sighted result-count renders as
                // the pipeline table's own caption directly above the rows
                // (the toolbar it used to share with the row-density toggle
                // is gone; the toggle itself was removed). `gap-3` gives the
                // filter row / table block / pagination even vertical rhythm
                // matching the tabs' own `pt-3`/`mb-3`.
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <UrgencyBucketTabs
                      current={monthLensActive ? null : urgency}
                      counts={summary.byUrgency}
                      lapsedCount={summary.lapsedCount}
                      monthLensActive={monthLensActive}
                    />
                    <TierFilterSelect current={tier ?? 'all'} />
                  </div>
                  {/* renewals-suspended-visibility-audit — the suspended
                      population bridge, rendered on the Suspended tab only
                      (the exact surface where the Members-page total vs tab
                      count mismatch confuses admins). The strip itself
                      renders nothing when no suspended cycles sit outside
                      the work window. */}
                  {!monthLensActive && urgency === 'suspended' ? (
                    // A3 — tenant-global pair (NOT the tier-sliced badge):
                    // the strip's three numbers must keep summing to the
                    // Members page's global Suspended count even while the
                    // badges are sliced by tier.
                    <SuspendedBridgeStrip
                      inWindowCount={summary.suspendedInWindowGlobalCount}
                      outsideWindowCount={summary.suspendedOutsideWindowCount}
                    />
                  ) : null}
                  <ResultCountAnnouncer
                    count={rows.length}
                    {...(monthLensActive
                      ? {
                          monthKind: monthKind as 'overdue' | 'later' | 'month',
                          ...(monthLabel !== undefined ? { monthLabel } : {}),
                        }
                      : { urgencyKey: urgency })}
                  />
                  {urgency === 'terminated' ? (
                    // LapsedTab has no toolbar of its own, so the sighted count
                    // stays a standalone caption hugging the table above it.
                    <div className="flex flex-col gap-2">
                      {resultCountLabel}
                      <LapsedTab rows={rows} />
                    </div>
                  ) : (
                    // Task 10 (US3 scaffolding) — PipelineWithBulk wraps
                    // PipelineTable, layering admin-only row selection on
                    // top (foundation for Task 11's bulk action bar). Pure
                    // render-order change: forwards the same props
                    // PipelineTable took directly before, plus
                    // isAdmin={canMutate} for the selection gate. No URL
                    // param name/default/semantics touched.
                    <PipelineWithBulk
                      rows={rows}
                      isAdmin={canMutate}
                      sort={sort}
                      sortHrefs={sortHrefs}
                      resultCount={resultCountLabel}
                      {...(monthKind !== undefined ? { monthKind } : {})}
                      {...(monthLabel !== undefined ? { monthLabel } : {})}
                    />
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
                </div>
              )
            }
            needsAction={<AtRiskWidget actorRole={widgetActorRole} />}
            needsActionBadge={
              <Suspense fallback={null}>
                <NeedsActionCountBadge tenantSlug={tenantCtx.slug} />
              </Suspense>
            }
          />
        </CardContent>
      </Card>
      {/* Renewals-by-month year view. Rendered BELOW the work-queue Card as a
          secondary lens and NOT gated behind `showEmptyState`: the urgency
          window can be empty while the 14-month chart still shows future
          renewals. Suspense-wrapped so its aggregation streams in without
          blocking the pipeline render; `nowIso` is the SAME instant threaded
          into `loadPipeline` above so the chart buckets and any
          month-filtered pipeline rows reconcile exactly. Wave 2 Task 7 moved
          this block below `WorkQueueTabs` (previously it sat between the
          pipeline Card and `AtRiskWidget`) so the two lenses stay adjacent. */}
      <Suspense fallback={<RenewalsByMonthSectionSkeleton />}>
        <RenewalsByMonthSection
          tenantSlug={tenantCtx.slug}
          nowIso={nowIso}
          selectedMonth={month}
        />
      </Suspense>
      {/* DV-18 — read-only "Members without renewal cycle" tray. Best-effort:
          the sub-component catches an infra throw + renders a load-error card,
          so it NEVER crashes the pipeline page. Mounted on the pipeline view
          only (not the pending-review discovery view). Suspense-wrapped so its
          anti-join query streams in instead of running as a serial waterfall
          after loadPipeline (keeps it off the pipeline's blocking render). */}
      <Suspense fallback={<MembersWithoutCycleTraySkeleton />}>
        <MembersWithoutCycleTray tenantSlug={tenantCtx.slug} />
      </Suspense>
    </RenewalsPageShell>
  );
}

/**
 * DV-Wave2 ⑥ — best-effort THB money KPI band section (Suspense island).
 *
 * Calls `loadPipelineMoney` and renders `<PipelineMoneyBand>`. Per-section
 * isolation: a money-query throw (F4 `invoices` read, or the cross-module F5
 * waived-refund read) or an unexpected `invalid_input` never crashes the
 * pipeline itself.
 *
 * `windowDays = 90` matches the pipeline's own T-90 planning window and drives
 * the "due soon within N days" caption.
 *
 * Fix round 1 #3 — `fiscalYearStartMonth` is now resolved from the tenant's
 * REAL `tenant_invoice_settings` row via `deps.fiscalYearSettings` (the same
 * `FiscalYearStartMonthPort` F9's revenue adapter and the F8 re-anchor path
 * already read), not silently defaulted to January. A non-January-FY tenant's
 * due-cohort boundary now shifts correctly. `getFiscalYearStartMonthInTx` is
 * tx-bound (mirrors every other F8 cross-tx read) — this Suspense island has
 * no tx of its own, so it opens ONE short-lived `runInTenant` purely to read
 * this single column; the adapter itself falls back to January (with a
 * warning log) when the tenant has no settings row yet.
 *
 * Fix round 1 I-2 — a load failure used to `return null`, silently vanishing
 * the whole KPI band. On a live money surface a treasurer reads "no band" as
 * "no dues owed / all collected" (a false-clear) and the Suspense skeleton's
 * CLS reservation was wasted. Now renders the REAL section title (scoping the
 * failure to "membership dues", not the whole page) + a MUTED
 * `role="status"`/`aria-live="polite"` notice (`LoadErrorCard tone="muted"` —
 * deliberately NOT the destructive `role="alert"`/`aria-live="assertive"`
 * skin, which would be disproportionate for one auxiliary band and would
 * interrupt the screen reader mid-announcement of the working pipeline).
 */
async function PipelineMoneyBandSection({
  tenantSlug,
  nowIso,
}: {
  readonly tenantSlug: string;
  readonly nowIso: string;
}) {
  const WINDOW_DAYS = 90;
  // Resolve the data inside try/catch, but construct the JSX AFTER it — a
  // render error from <PipelineMoneyBand> must reach the Suspense error
  // boundary, not this best-effort data catch (react-hooks/error-boundaries).
  let money: PipelineMoneySummary | null = null;
  try {
    const deps = makeRenewalsDeps(tenantSlug);
    const fiscalYearStartMonth = await runInTenant(
      asTenantContext(tenantSlug),
      (tx) => deps.fiscalYearSettings.getFiscalYearStartMonthInTx(tx, tenantSlug),
    );
    const result = await loadPipelineMoney(deps, {
      tenantId: tenantSlug,
      nowIso,
      windowDays: WINDOW_DAYS,
      fiscalYearStartMonth,
    });
    if (result.ok) {
      money = result.value;
    } else {
      logger.error(
        {
          errorId: 'F8.ADMIN.MONEY_BAND',
          tenantId: tenantSlug,
          error: result.error.kind,
        },
        '[admin/renewals] money band load returned an error',
      );
    }
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.MONEY_BAND',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] money band load failed',
    );
  }
  if (money === null) {
    const tMoney = await getTranslations('admin.renewals.money');
    return (
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{tMoney('title')}</h2>
        {/* renewals-money-band-compact4 — the skeleton above now reserves
            the compact 4-tile grid's footprint (one row of `Card size="sm"`
            tiles on desktop; 4 stacked rows on mobile), not the 2-KPI
            strip's single card; this collapsed error card is shorter still,
            so without a floor the (rare) load-failure path yanks the rest of
            the pipeline up a CLS-visible amount. `min-h-32` (128px)
            approximates one compact tile row's real footprint (`size="sm"`
            Card py-3 + a label line + a ~32px `text-2xl` value + a
            caption line, with headroom for the caption wrapping to 2 lines)
            — not pixel-exact at every breakpoint (mobile stacks 4 tiles
            taller than this floor), but enough to keep the failure path from
            visibly shrinking the band on the common desktop case. */}
        <div className="min-h-32">
          <LoadErrorCard tone="muted" message={tMoney('loadFailed')} />
        </div>
      </section>
    );
  }
  return <PipelineMoneyBand money={money} windowDays={WINDOW_DAYS} />;
}

/**
 * Fix I-1 (review round 1) — best-effort count badge for the `WorkQueueTabs`
 * "Needs action" tab, streamed in a Suspense island so it never blocks the
 * pipeline render. Restores the at-risk discoverability that regressed when
 * Task 7 folded the always-visible `AtRiskWidget` behind an inactive tab:
 * without a count, an admin has no signal that the "Needs action" lens has
 * work in it.
 *
 * Reuses the SAME whole-tenant summary the `/api/admin/renewals/at-risk`
 * route already reads — `memberRenewalFlagsRepo.listAtRiskWidgetMembers`
 * with `limit: 1` (the widget's own default fetch never varies this
 * summary by page size or band filter, so `limit: 1` costs the same
 * aggregate query as any other limit). Deliberately NOT a new use-case —
 * the summary is already a cheap band-count aggregate, band-independent of
 * the paginated `items`. Count = `critical + atRisk` (the "actionable now"
 * set) — `warning` is intentionally excluded, matching the widget's own
 * default band tab of `at-risk` rather than `warning`.
 *
 * Best-effort: a read failure logs a distinct errorId and renders `null` —
 * the tab itself always renders regardless (never crashes the page).
 */
async function NeedsActionCountBadge({
  tenantSlug,
}: {
  readonly tenantSlug: string;
}) {
  const t = await getTranslations('admin.renewals.workQueue');
  let count: number;
  try {
    const deps = makeRenewalsDeps(tenantSlug);
    const page = await runInTenant(asTenantContext(tenantSlug), (tx) =>
      deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(tx, tenantSlug, {
        limit: 1,
      }),
    );
    count = page.summary.critical + page.summary.atRisk;
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.NEEDS_ACTION_BADGE',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] needs-action badge count load failed',
    );
    return null;
  }
  if (count <= 0) return null;
  return (
    <TabCountBadge count={count} label={t('needsActionCountSr', { count })} />
  );
}

/**
 * Item ④ (Wave 1 Task 2, plan-wide decision) — streams the three tab-count
 * badges (Pending review / Tasks / Tier upgrades) onto the pipeline view's
 * section tabs WITHOUT adding a query to the pipeline hot path (rendered in
 * a Suspense island by the caller). Reuses EXISTING reads — no new
 * use-case or repo method is authored:
 *
 *   - `pendingReviewCount` — `loadPendingReactivationReview` (same
 *     use-case the "Pending review" view itself renders from).
 *   - `tasksCount` — `escalationTaskRepo.countMatching` with the SAME
 *     `statusFilter: ['open']` shape the Tasks page's overdue-banner count
 *     already uses (just without the overdue-only narrowing), so this is
 *     the total open-task queue size.
 *   - `tierUpgradeCount` — `tierUpgradeRepo.listForAdminQueue` (the exact
 *     call the Tier-upgrades page makes), taking `.items.length` — bounded
 *     by the same `limit: 50` the page itself uses.
 *
 * The three reads run concurrently via `Promise.allSettled` so one load
 * failure degrades ONLY that badge to hidden (count 0) rather than
 * blanking all three — each rejection is logged with a distinct errorId
 * for SRE triage.
 */
async function PipelineSectionTabsWithCount({
  tenantSlug,
}: {
  readonly tenantSlug: string;
}) {
  const deps = makeRenewalsDeps(tenantSlug);
  const [pendingReviewResult, tasksResult, tierUpgradeResult] =
    await Promise.allSettled([
      loadPendingReactivationReview(deps, { tenantId: tenantSlug }),
      deps.escalationTaskRepo.countMatching(tenantSlug, {
        statusFilter: ['open'],
      }),
      deps.tierUpgradeRepo.listForAdminQueue(tenantSlug, { limit: 50 }),
    ]);

  let pendingReviewCount = 0;
  if (pendingReviewResult.status === 'fulfilled') {
    if (pendingReviewResult.value.ok) {
      // UX-audit PR-B B5 — count only cycles still awaiting a decision. Cycles
      // carrying the async reject-with-refund marker are ALREADY decided
      // (rejected; refund settling) and the list renders them read-only, so
      // counting them as open work overstates the badge (UX-A Bug 2 parity).
      pendingReviewCount = countOpenPendingReviewCycles(
        pendingReviewResult.value.value.cycles,
      );
    }
  } else {
    logger.error(
      {
        errorId: 'F8.ADMIN.PENDING_REVIEW_COUNT',
        err:
          pendingReviewResult.reason instanceof Error
            ? pendingReviewResult.reason.message
            : String(pendingReviewResult.reason),
        tenantId: tenantSlug,
      },
      '[admin/renewals] pending-review count load failed',
    );
  }

  let tasksCount = 0;
  if (tasksResult.status === 'fulfilled') {
    tasksCount = tasksResult.value;
  } else {
    logger.error(
      {
        errorId: 'F8.ADMIN.TASKS_COUNT',
        err:
          tasksResult.reason instanceof Error
            ? tasksResult.reason.message
            : String(tasksResult.reason),
        tenantId: tenantSlug,
      },
      '[admin/renewals] open-tasks count load failed',
    );
  }

  let tierUpgradeCount = 0;
  if (tierUpgradeResult.status === 'fulfilled') {
    tierUpgradeCount = tierUpgradeResult.value.items.length;
  } else {
    logger.error(
      {
        errorId: 'F8.ADMIN.TIER_UPGRADE_COUNT',
        err:
          tierUpgradeResult.reason instanceof Error
            ? tierUpgradeResult.reason.message
            : String(tierUpgradeResult.reason),
        tenantId: tenantSlug,
      },
      '[admin/renewals] tier-upgrade count load failed',
    );
  }

  return (
    <RenewalsSectionTabs
      showPipelineHelp
      pendingReviewCount={pendingReviewCount}
      tasksCount={tasksCount}
      tierUpgradeCount={tierUpgradeCount}
    />
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
    // UX-A Bug 2: thread the async reject-with-refund marker into the row so a
    // decided (refund-settling) cycle shows the "Refund settling" pill + "View"
    // CTA instead of overstating open review work.
    refundSettling: c.rejectRefundInitiatedAt !== null,
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
