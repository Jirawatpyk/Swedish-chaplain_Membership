/**
 * 122 US7a (T710) — the renewals pipeline page's view, shared by the page
 * and the no-DB preview route (`/test-fixtures/aura-admin?view=renewals`), so
 * the screenshots show the page itself, never a copy of its layout. Board
 * `Admin-renewals` (+ `-mobile`, `-needs-action`, `Admin-state-renewals-empty`).
 *
 * The page keeps the data: it passes its Suspense islands (money band,
 * section-tab counts, by-month chart, tray) as nodes, and the resolved
 * pipeline read to `renderPipelineLens`. It also keeps its own
 * `TableContainer` + `PageHeader` (check:layout reads the page file).
 */
import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import { ErrorCardActions } from '@/components/shell/error-card-actions';
import type { PipelineSort, PipelineSummary, TierBucket, UrgencyBucket } from '@/modules/renewals';
import type { PipelineRow } from '@/modules/renewals/client';
import { ResultCountAnnouncer } from '@/components/renewals/result-count-announcer';
import { ResultCountLabel } from '@/components/renewals/result-count-label';
import { RenewalsEmptyState } from './empty-state';
import { SuspendedBridgeStrip } from './suspended-bridge-strip';
import { UrgencyBucketTabs } from './urgency-bucket-tabs';
import { TierFilterSelect } from './tier-filter-select';
import { LapsedTab } from './lapsed-tab';
import { PipelineWithBulk } from './pipeline-with-bulk';
import { WorkQueueTabs } from './work-queue-tabs';

export interface RenewalsPipelineViewProps {
  /** The THB money band (the page's Suspense island). */
  readonly moneyBand: ReactNode;
  /** Pipeline / Pending review / Tasks / Tier upgrades, with their counts. */
  readonly sectionTabs: ReactNode;
  /** The All renewals panel: `renderPipelineLens`. */
  readonly pipeline: ReactNode;
  /** The Needs action panel: the at-risk widget. */
  readonly needsAction: ReactNode;
  readonly needsActionCount?: number | undefined;
  /** The work-queue lens shown first (the preview's needs-action view). */
  readonly defaultLens?: 'pipeline' | 'needsAction' | undefined;
  /** "Renewals by month" (the page's Suspense island). */
  readonly byMonth: ReactNode;
  /** Members without a renewal cycle (the page's Suspense island). */
  readonly tray: ReactNode;
}

export function renderRenewalsPipelineView({
  moneyBand,
  sectionTabs,
  pipeline,
  needsAction,
  needsActionCount,
  defaultLens,
  byMonth,
  tray,
}: RenewalsPipelineViewProps) {
  return (
    <>
      {moneyBand}
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          {sectionTabs}
          {/* Wave 2 Task 7 — the pipeline and the at-risk widget are the two
              lenses of ONE `WorkQueueTabs` control. Pure client state (no URL
              param), so the pipeline URL contracts are untouched. */}
          <WorkQueueTabs
            pipeline={pipeline}
            needsAction={needsAction}
            {...(needsActionCount !== undefined ? { needsActionCount } : {})}
            {...(defaultLens !== undefined ? { defaultLens } : {})}
          />
        </div>
      </Card>
      {byMonth}
      {tray}
    </>
  );
}

export interface PipelineLensProps {
  readonly rows: ReadonlyArray<PipelineRow>;
  readonly summary: PipelineSummary;
  readonly urgency: UrgencyBucket;
  readonly tier: TierBucket | undefined;
  readonly monthLensActive: boolean;
  readonly monthKind: 'overdue' | 'later' | 'month' | undefined;
  readonly monthLabel: string | undefined;
  readonly sort: PipelineSort;
  readonly sortHrefs: Record<'expires' | 'tier', string>;
  /** "Next 50" when the read was capped; null on the last page. */
  readonly nextHref: string | null;
  /** `shouldShowRenewalsEmptyState` — no filter active and nothing due. */
  readonly showEmptyState: boolean;
  /** `renewals.write`: row selection, the bulk bar and the row mutations. */
  readonly canMutate: boolean;
  /** `settings.renewal_schedules`: the empty state's settings link. */
  readonly canManageSchedules: boolean;
}

/** The All renewals panel: the empty state, or the filters, table and paging. */
export async function renderPipelineLens({
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
  canManageSchedules,
}: PipelineLensProps) {
  if (showEmptyState) {
    // A2 — the empty state must not swallow the suspended bridge: the
    // launch-shaped tenant (every member a first-bill collection case
    // outside the window) hits exactly this branch. A3 — tenant-global pair
    // (NOT the tier-sliced badge): the bridge reconciles against the Members
    // page's global Suspended number.
    return (
      <RenewalsEmptyState
        canManageSchedules={canManageSchedules}
        suspendedInWindowCount={summary.suspendedInWindowGlobalCount}
        suspendedOutsideWindowCount={summary.suspendedOutsideWindowCount}
      />
    );
  }

  const t = await getTranslations('admin.renewals');
  const lensProps = monthLensActive
    ? {
        monthKind: monthKind as 'overdue' | 'later' | 'month',
        ...(monthLabel !== undefined ? { monthLabel } : {}),
      }
    : { urgencyKey: urgency };
  // Sighted result-count (aria-hidden twin of `ResultCountAnnouncer`): the
  // pipeline table's caption, or the standalone caption above `LapsedTab`.
  const resultCountLabel = <ResultCountLabel count={rows.length} {...lensProps} />;

  return (
    <div className="flex flex-col gap-3">
      {/* Board `Admin-renewals`: the stage chips, then the Tier select at the
          row's end; `-mobile`: the Urgency and Tier selects side by side. */}
      <div className="grid grid-cols-2 items-end gap-[var(--aura-space-3)] sm:flex sm:justify-between">
        <UrgencyBucketTabs
          current={monthLensActive ? null : urgency}
          counts={summary.byUrgency}
          lapsedCount={summary.lapsedCount}
          monthLensActive={monthLensActive}
        />
        <TierFilterSelect current={tier ?? 'all'} />
      </div>
      {/* renewals-suspended-visibility-audit — the suspended population
          bridge, on the Suspended tab only (where the Members-page total vs
          tab count mismatch confuses admins). A3 — tenant-global pair, so
          the strip's numbers keep summing to the Members page's global
          Suspended count even while the badges are sliced by tier. */}
      {!monthLensActive && urgency === 'suspended' ? (
        <SuspendedBridgeStrip
          inWindowCount={summary.suspendedInWindowGlobalCount}
          outsideWindowCount={summary.suspendedOutsideWindowCount}
        />
      ) : null}
      <ResultCountAnnouncer count={rows.length} {...lensProps} />
      {urgency === 'terminated' ? (
        // LapsedTab has no toolbar of its own, so the sighted count stays a
        // standalone caption hugging the table above it.
        <div className="flex flex-col gap-2">
          {resultCountLabel}
          <LapsedTab rows={rows} />
        </div>
      ) : (
        // PipelineWithBulk layers admin-only row selection and the bulk bar
        // on top of PipelineTable. No URL param name/default/semantics touched.
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
        // Keyset cursor pagination: the read was capped at 50 rows. A
        // "Next 50" link (same pattern as /admin/audit) + a visible
        // "Showing first 50" hint so everyone knows the list is truncated.
        // UrgencyBucketTabs drops the cursor on a tab switch.
        <div className="flex items-center justify-between gap-4 pt-1">
          <p className="text-xs text-[var(--aura-fg-secondary)]">
            {t('table.pagination.showingFirst')}
          </p>
          <a href={nextHref} className={buttonClass({ variant: 'secondary' })}>
            {t('table.pagination.next')}
          </a>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The pipeline read failed (`Admin-state-renewals-error`): AURA's danger
 * empty state replaces the work queue — the message, Try again / Go back, and
 * the reference id (`correlationId`, the one the page logged) beneath.
 *
 * K12-1 (UX-K-3): Retry was a `<Link>` with a `?_retry=${id}` cache-bust,
 * which read as navigation to AT (WCAG SC 4.1.2) and polluted history.
 * ErrorCardActions runs `router.refresh()` inside `useTransition` — a
 * semantic button, no URL mutation, a pending state for the RSC re-fetch.
 */
export async function renderPipelineLoadError(correlationId: string) {
  const t = await getTranslations('admin.renewals.error');
  return (
    <EmptyState
      role="alert"
      bordered
      tone="danger"
      headingLevel={false}
      icon="triangle-alert"
      title={t('loadFailed')}
      action={
        <div className="flex flex-col items-center gap-[var(--aura-space-3)]">
          <ErrorCardActions
            correlationId={correlationId}
            goBackHref="/admin"
            retryLabel={t('retry')}
            pendingLabel={t('retrying')}
            retryFailedLabel={t('retryFailed')}
            goBackLabel={t('goBack')}
            referenceLabel={t('referenceLabel')}
          />
        </div>
      }
    />
  );
}
