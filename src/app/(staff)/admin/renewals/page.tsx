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
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { renewalsMetrics } from '@/lib/metrics';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import {
  resolveMemberNumberPrefix,
  formatMemberNumber,
  drizzleMemberSettingsRepo,
} from '@/modules/members';
import {
  loadPipeline,
  loadPipelineMoney,
  loadPendingReactivationReview,
  loadRenewalMonthSummary,
  loadMembersWithoutCycle,
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
import { settle, type Settled } from './_lib/settled';
import { formatMonthKeyLabel } from '@/components/renewals/month-bucket-label';
import {
  RenewalsByMonthSection,
  RenewalsByMonthSectionSkeleton,
} from './_components/renewals-by-month-section';
import { shouldShowRenewalsEmptyState } from './_lib/should-show-empty-state';
import {
  PipelineMoneyBand,
  PipelineMoneyBandSkeleton,
} from './_components/pipeline-money-band';
import { LoadErrorCard } from '@/components/shell/load-error-card';
import { ErrorCardActions } from '@/components/shell/error-card-actions';
import { AtRiskWidget } from './_components/at-risk-widget';
import {
  renderPipelineLens,
  renderPipelineLoadError,
  renderRenewalsPipelineView,
} from './_components/renewals-pipeline-view';
import {
  MembersWithoutCycleTray,
  MembersWithoutCycleTraySkeleton,
} from './_components/members-without-cycle-tray';
import { RenewalsSectionTabs } from './_components/renewals-section-tabs';
import {
  RenewalsSectionTabsWithCounts,
  loadSectionTabCounts,
} from './_components/renewals-section-tabs-with-counts';
import {
  PendingReviewList,
  type PendingReviewRow,
} from './_components/pending-review-list';
import {
  fetchPendingReviewCompanyNames,
  type PendingReviewMemberInfo,
} from './_lib/pending-review-enrichment';

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

/**
 * B3 (UX-audit PR-B #9) — a pending-review decision lingering this many days
 * (or more) is stale ops and gets a subtle amber "Aged {n}d" chip so the most
 * overdue decisions stand out. Computed server-side (`enteredPendingAt` + now).
 * Proposed 7 (a full week) — enterprise-ux confirms the threshold in review.
 */
const PENDING_REVIEW_AGING_DAYS = 7;
const PENDING_REVIEW_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Money-band window — matches the pipeline's own T-90 planning window and
 * drives the "due soon within N days" caption. Module-level (was local to
 * `PipelineMoneyBandSection`) because the eager-island waterfall fix creates
 * the band's data promise in the page body while the band section renders it
 * — both must read ONE constant.
 */
const MONEY_BAND_WINDOW_DAYS = 90;

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
  const { user: currentUser } = await requirePagePermission('renewals.read');

  if (!env.features.f8Renewals) {
    return (
      <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
        <Card>
          <p
            role="status"
            aria-live="polite"
            className="py-[var(--aura-space-8)] text-center text-[var(--aura-fg-secondary)]"
          >
            {t('error.featureDisabled')}
          </p>
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
  //
  // Waterfall audit (eager-island fix): this view is INTENTIONALLY not
  // converted — its body awaits no data query before returning (only
  // session/translations/getLocale, all required before any tenant-scoped
  // promise could be created anyway), so `RenewalsSectionTabsWithCounts`
  // and `PendingReviewSection` already start their reads concurrently at
  // first render. There is no waterfall here to remove.
  if (isPendingReviewView) {
    const locale = await getLocale();
    return (
      <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
        <Card>
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* C3 (#8) — the Pending-review view now also carries the sibling-
                queue count badges (Tasks / Tier upgrades / its own Pending
                review), streamed in a Suspense island whose fallback is the
                bare strip (CLS-safe, only the badges appear once resolved). */}
            <Suspense fallback={<RenewalsSectionTabs />}>
              <RenewalsSectionTabsWithCounts tenantSlug={tenantCtx.slug} />
            </Suspense>
            <PendingReviewSection
              tenantSlug={tenantCtx.slug}
              locale={locale}
              // B2 — manager views this queue read-only; the reactivate route
              // admits `renewals.write` holders, so the inline Approve follows
              // the same pair (016 re-review D — the old `role === 'admin'`
              // literal went false for every human after Migration C).
              canApprove={canPerform(currentUser.role, 'renewals.write')}
            />
          </div>
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

  // ---- Eager Suspense-island data (waterfall fix) --------------------------
  // The `await loadPipeline` below blocks this body from RETURNING its JSX,
  // so every Suspense island used to START its own queries only AFTER the
  // pipeline query resolved — a serial waterfall (operator-visible symptom:
  // the money band double-skeletons and always fills last). Fire each
  // island's data promise NOW; the island awaits the already-running promise
  // inside its Suspense boundary. `settle()` (see `_lib/settled.ts`) attaches
  // the rejection handler AT CREATION so a failure during the pipeline await
  // can never become an unhandled rejection — each island unwraps and keeps
  // its exact pre-existing best-effort error semantics.
  //
  // Connection-pool note: these ~5 queries already ran CONCURRENTLY with
  // each other today (all islands mounted together post-body); this only
  // shifts their START time earlier to overlap `loadPipeline` — no net new
  // load on the Neon pool.
  //
  // `nowIso` threading is unchanged: the SAME instant goes into
  // `loadPipeline` below, the money band, and the by-month aggregation
  // (chart/pipeline reconciliation invariant).
  //
  // The money band's fiscalYearStartMonth read deliberately stays INSIDE
  // this promise (sequential with its own loadPipelineMoney): it is that
  // query's input, and no other consumer on this page needs it — starting
  // the pair early is the win, not splitting them.
  const moneyBandPromise = settle(
    (async () => {
      const fiscalYearStartMonth = await runInTenant(
        asTenantContext(tenantCtx.slug),
        (tx) =>
          deps.fiscalYearSettings.getFiscalYearStartMonthInTx(
            tx,
            tenantCtx.slug,
          ),
      );
      return loadPipelineMoney(deps, {
        tenantId: tenantCtx.slug,
        nowIso,
        windowDays: MONEY_BAND_WINDOW_DAYS,
        fiscalYearStartMonth,
      });
    })(),
  );
  // Never rejects (per-read allSettled + logging inside) — no settle needed.
  const sectionCountsPromise = loadSectionTabCounts(tenantCtx.slug);
  const needsActionCountPromise = settle(
    runInTenant(asTenantContext(tenantCtx.slug), (tx) =>
      deps.memberRenewalFlagsRepo.listAtRiskWidgetMembers(tx, tenantCtx.slug, {
        limit: 1,
      }),
    ),
  );
  const byMonthSummaryPromise = settle(
    loadRenewalMonthSummary(deps, { tenantId: tenantCtx.slug, nowIso }),
  );
  const membersWithoutCyclePromise = settle(
    loadMembersWithoutCycle(deps, { tenantId: tenantCtx.slug }),
  );

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
        {await renderPipelineLoadError(correlationId)}
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
  // Its per-row Snooze posts to a `renewals.write` route, so it is gated on
  // `canMutate` below — not on a role projection, which answered wrongly for
  // any role that is neither manager nor admin.

  // Fix round 3 (manager money-CTA gating) — threaded into `<PipelineTable>`
  // and `<AtRiskWidget>` to hide the admin-only row mutation affordances
  // ("Send reminder" / "Mark paid" / "Snooze") from a read-only manager.
  // Server-side 403 guards on those
  // routes stay in place as defence-in-depth; this only fixes the client
  // affordance so a manager never sees a CTA that would just 403.
  // 016 T030 — evaluator-derived (the old `role === 'admin'` literal hid
  // every mutation CTA from a promoted super_admin while the API allowed it).
  const canMutate = canPerform(currentUser.role, 'renewals.write');

  // The needs-action count rides on the work-queue tab (AURA's numeric
  // `count`), so it is resolved here; its read started beside `loadPipeline`.
  const needsActionCount = await resolveNeedsActionCount(
    tenantCtx.slug,
    needsActionCountPromise,
  );

  return (
    <RenewalsPageShell title={t('title')} subtitle={t('subtitle')}>
      {renderRenewalsPipelineView({
        // DV-Wave2 ⑥ — THB money KPI band. Best-effort Suspense island: it
        // streams in independently of the pipeline table and a load throw
        // degrades it to its caption (never crashes the pipeline). Reuses the
        // already-computed `nowIso` so its FY/BKK boundaries reconcile with
        // the month lens. `PipelineMoneyBandSkeleton` reserves the identical
        // footprint (fix round 1 #1 — a `null` fallback was a real CLS hit).
        moneyBand: (
          <Suspense fallback={<PipelineMoneyBandSkeleton />}>
            <PipelineMoneyBandSection
              tenantSlug={tenantCtx.slug}
              moneyPromise={moneyBandPromise}
            />
          </Suspense>
        ),
        // 070 F8 item #18 — section nav reachable from the pipeline. Item ④ —
        // each tab's pending-work count streams in a Suspense island (the
        // EXISTING use-cases, zero new queries) so the pipeline hot path stays
        // query-free; the fallback is the identical strip with NO badges
        // (CLS-safe). Best-effort per count: a throw hides that ONE badge.
        sectionTabs: (
          <Suspense fallback={<RenewalsSectionTabs />}>
            <RenewalsSectionTabsWithCounts
              tenantSlug={tenantCtx.slug}
              countsPromise={sectionCountsPromise}
            />
          </Suspense>
        ),
        pipeline: await renderPipelineLens({
          rows,
          summary,
          urgency,
          tier,
          monthLensActive,
          monthKind,
          monthLabel,
          sort,
          sortHrefs,
          nextHref,
          showEmptyState,
          canMutate,
          canManageSchedules: canPerform(currentUser.role, 'settings.renewal_schedules'),
        }),
        // Waterfall audit: `AtRiskWidget` is a CLIENT component that fetches
        // `/api/admin/renewals/at-risk` on mount — its fetch already starts
        // client-side, independent of `loadPipeline`.
        needsAction: <AtRiskWidget canSnooze={canMutate} />,
        needsActionCount,
        // Renewals-by-month year view — BELOW the work-queue card, NOT gated
        // behind `showEmptyState`: the urgency window can be empty while the
        // 14-month chart still shows future renewals. `nowIso` is the SAME
        // instant threaded into `loadPipeline`, so the chart buckets and any
        // month-filtered pipeline rows reconcile exactly.
        byMonth: (
          <Suspense fallback={<RenewalsByMonthSectionSkeleton />}>
            <RenewalsByMonthSection
              tenantSlug={tenantCtx.slug}
              nowIso={nowIso}
              selectedMonth={month}
              summaryPromise={byMonthSummaryPromise}
            />
          </Suspense>
        ),
        // DV-18 — read-only "Members without renewal cycle" tray. Best-effort
        // (an infra throw renders its own load-error card) and streamed, so
        // its anti-join never runs as a serial waterfall after loadPipeline.
        tray: (
          <Suspense fallback={<MembersWithoutCycleTraySkeleton />}>
            <MembersWithoutCycleTray
              tenantSlug={tenantCtx.slug}
              resultPromise={membersWithoutCyclePromise}
            />
          </Suspense>
        ),
      })}
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
  moneyPromise,
}: {
  readonly tenantSlug: string;
  /**
   * Waterfall fix (eager-island pattern, `_lib/settled.ts`) — the page
   * CREATES the fiscalYearStartMonth-read + `loadPipelineMoney` pair BEFORE
   * its blocking `await loadPipeline` (the double-skeleton the operator
   * saw: this band's queries used to start only after the pipeline query
   * finished). Settled at creation; the unwrap below preserves the exact
   * pre-existing best-effort branches: result-error → same log + hidden
   * band with caption, throw → same log + hidden band with caption.
   */
  readonly moneyPromise: Promise<
    Settled<Awaited<ReturnType<typeof loadPipelineMoney>>>
  >;
}) {
  // Unwrap outside any try/catch, then construct the JSX AFTER — a render
  // error from <PipelineMoneyBand> must reach the Suspense error boundary,
  // not this best-effort data path (react-hooks/error-boundaries).
  let money: PipelineMoneySummary | null = null;
  const settled = await moneyPromise;
  if (settled.ok) {
    const result = settled.v;
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
  } else {
    const e = settled.e;
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
  return <PipelineMoneyBand money={money} windowDays={MONEY_BAND_WINDOW_DAYS} />;
}

/**
 * Fix I-1 (review round 1) — best-effort count for the `WorkQueueTabs`
 * "Needs action" tab. 122 US7a (T703): resolved by the page (the read starts
 * before `await loadPipeline`, so it adds no serial wait) because AURA's tab
 * takes a numeric `count`; streaming it into the tab would remount the lens. Restores the at-risk discoverability that regressed when
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
 * Best-effort: a read failure logs a distinct errorId and yields no count —
 * the tab itself always renders regardless (never crashes the page).
 */
async function resolveNeedsActionCount(
  tenantSlug: string,
  /**
   * Waterfall fix (eager-island pattern, `_lib/settled.ts`) — the page fires
   * the `listAtRiskWidgetMembers limit:1` summary read BEFORE `await
   * loadPipeline`. Settled at creation.
   */
  countPromise: Promise<
    Settled<{
      readonly summary: { readonly critical: number; readonly atRisk: number };
    }>
  >,
): Promise<number | undefined> {
  const settled = await countPromise;
  if (!settled.ok) {
    const e = settled.e;
    logger.error(
      {
        errorId: 'F8.ADMIN.NEEDS_ACTION_BADGE',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] needs-action badge count load failed',
    );
    return undefined;
  }
  return settled.v.summary.critical + settled.v.summary.atRisk;
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
  canApprove,
}: {
  readonly tenantSlug: string;
  readonly locale: string;
  /**
   * B2 — admin-only gate for the inline Approve action. This surface is
   * viewable by admin AND (read-only) manager; the reactivate route is
   * admin-only, so a manager gets the read-only list (Review link, no Approve).
   */
  readonly canApprove: boolean;
}) {
  const t = await getTranslations('admin.renewals.pendingReview');
  // B1 (UX-audit PR-B #3) — error-card copy is shared with the pipeline's own
  // retry card (`admin.renewals.error.*`), so pending-review reuses it verbatim.
  const tError = await getTranslations('admin.renewals.error');
  const deps = makeRenewalsDeps(tenantSlug);

  let cycles: LoadPendingReactivationReviewOutput['cycles'];
  // memberId → {companyName, memberNumber, memberId}, resolved in ONE batched
  // member read (no N+1). B4 — richer shape drives the company LINK + SCCM cell.
  let memberInfo: ReadonlyMap<string, PendingReviewMemberInfo>;
  // 055 member-number — per-tenant SCCM prefix, resolved once via the shared
  // RLS-safe helper (mirrors the admin members list).
  let memberPrefix: string;
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

    // Batch-enrich member facts (company + member-number) in a SINGLE
    // tenant-scoped read AND resolve the SCCM prefix (a separate RLS-safe
    // read), overlapped. Either throw (RLS reject / connection / timeout) is
    // caught below and renders the same "couldn't load" alert as a cycle-load
    // failure — never a silently blank list.
    [memberInfo, memberPrefix] = await Promise.all([
      fetchPendingReviewCompanyNames({
        tenantSlug,
        memberIds: cycles.map((c) => c.memberId),
      }),
      resolveMemberNumberPrefix(
        asTenantContext(tenantSlug),
        drizzleMemberSettingsRepo,
      ),
    ]);
  } catch (e) {
    // B1 (UX-audit PR-B #3) — pending-review previously rendered a DEAD-END
    // LoadErrorCard (no retry), while the SAME page gives the pipeline error
    // card a working retry. Reuse the pipeline's `ErrorCardActions`
    // (router.refresh() in a transition — semantic button, no URL mutation)
    // with a minted correlationId surfaced for SRE triage + the reference cell.
    const correlationId = randomUUID();
    logger.error(
      {
        errorId: 'F8.ADMIN.PENDING_REVIEW_LOAD',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
        correlationId,
      },
      '[admin/renewals] pending-review load failed',
    );
    return (
      <LoadErrorCard message={t('loadFailed')}>
        <ErrorCardActions
          correlationId={correlationId}
          goBackHref="/admin/renewals"
          retryLabel={tError('retry')}
          pendingLabel={tError('retrying')}
          retryFailedLabel={tError('retryFailed')}
          goBackLabel={tError('goBack')}
          referenceLabel={tError('referenceLabel')}
        />
      </LoadErrorCard>
    );
  }

  // Tenant-TZ pin (#315 follow-up, server-UTC display class): this formats
  // timestamptz INSTANTS (entered_pending_at / expires_at) — the UTC Vercel
  // runtime rendered the wrong calendar day for instants ≥ 17:00 UTC.
  const dtFmtDay = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
    timeZone: env.tenant.timezone,
  });
  const fmtDateOnly = (s: string | null | undefined): string =>
    s ? dtFmtDay.format(new Date(s)) : '—';

  // B3 — single wall-clock read for the whole list so every row's aging is
  // measured against the same instant (no per-row `Date.now()` drift).
  const now = Date.now();

  const rows: PendingReviewRow[] = cycles.map((c) => {
    const info = memberInfo.get(c.memberId);
    // B3 — aging measured off `enteredPendingAt`. A pending cycle always has it
    // set (discriminated union), but the array element type is the RenewalCycle
    // union, so guard the null arm defensively: no timestamp → epoch NaN (sorts
    // last, never aged).
    const pendingSinceEpoch = c.enteredPendingAt
      ? Date.parse(c.enteredPendingAt)
      : Number.NaN;
    const agingDays = Number.isFinite(pendingSinceEpoch)
      ? Math.floor((now - pendingSinceEpoch) / PENDING_REVIEW_DAY_MS)
      : 0;
    return {
      cycleId: c.cycleId,
      // B4 — a resolved member links to `/admin/members/{id}` with its SCCM
      // number in muted text (escalation-queue + invoice-table parity). A
      // member absent from the batch map (archived / cross-tenant-hidden)
      // degrades to the cycle short-id as PLAIN TEXT (no link, no SCCM) — the
      // same graceful fallback as before, still without a per-row query.
      companyName: info?.companyName ?? c.cycleId.slice(0, 8),
      memberId: info?.memberId ?? null,
      memberNumberDisplay:
        info !== undefined
          ? formatMemberNumber(memberPrefix, info.memberNumber)
          : null,
      pendingSinceLabel: fmtDateOnly(c.enteredPendingAt),
      // B3 — raw sort key alongside the pre-formatted display label; the client
      // sorts on this, never on the localized/BE string.
      pendingSinceEpoch,
      expiryLabel: fmtDateOnly(c.expiresAt),
      // UX-A Bug 2: thread the async reject-with-refund marker into the row so a
      // decided (refund-settling) cycle shows the "Refund settling" pill + "View"
      // CTA instead of overstating open review work.
      refundSettling: c.rejectRefundInitiatedAt !== null,
      // B3 — aging chip flag + day count for the amber "Aged {n}d" treatment.
      isAged: agingDays >= PENDING_REVIEW_AGING_DAYS,
      agingDays,
    };
  });

  return (
    <>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('sectionTitle')}</h2>
        <p className="text-sm text-muted-foreground">{t('sectionSubtitle')}</p>
      </div>
      <PendingReviewList rows={rows} canApprove={canApprove} />
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
