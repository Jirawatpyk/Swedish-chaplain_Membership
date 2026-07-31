/**
 * Enhancement C3 (#8) — shared count-bearing section-tabs island.
 *
 * Streams the three tab-count badges (Pending review / Tasks / Tier upgrades)
 * onto the renewals section tabs WITHOUT adding a query to any page's blocking
 * render. Extracted from the pipeline `page.tsx` (where it was `PipelineSection
 * TabsWithCount`, only ever mounted on the Pipeline view) so ALL FOUR renewals
 * surfaces — Pipeline, Pending review, Tasks, Tier upgrades — show how much
 * work waits in the sibling queues. Callers wrap it in a `<Suspense>` whose
 * fallback is the bare `<RenewalsSectionTabs>` (no badges) so it stays off the
 * blocking render and is CLS-safe (only the badges appear once resolved).
 *
 * Reuses EXISTING reads — no new use-case or repo method is authored:
 *
 *   - `pendingReviewCount` — `loadPendingReactivationReview` (same use-case the
 *     "Pending review" view itself renders from). The badge uses the HONEST
 *     open-count (`countOpenPendingReviewCycles`, shipped in #301): cycles that
 *     carry the async reject-with-refund marker are already decided and render
 *     read-only, so counting them would overstate the badge.
 *   - `tasksCount` — `escalationTaskRepo.countMatching` with the SAME
 *     `statusFilter: ['open']` shape the Tasks page's overdue-banner count uses
 *     (without the overdue-only narrowing) — the total open-task queue size.
 *   - `tierUpgradeCount` — `tierUpgradeRepo.listForAdminQueue` (the exact call
 *     the Tier-upgrades page makes), taking `.items.length` — bounded by the
 *     same `limit: 50` the page itself uses.
 *
 * The three reads run concurrently via `Promise.allSettled` so ONE load failure
 * degrades ONLY that badge to hidden (count 0) rather than blanking all three —
 * each rejection is logged with a distinct errorId for SRE triage.
 */
import { logger } from '@/lib/logger';
import { loadPendingReactivationReview, makeRenewalsDeps } from '@/modules/renewals';
import { RenewalsSectionTabs } from './renewals-section-tabs';
import { countOpenPendingReviewCycles } from '../_lib/pending-review-open-count';

export interface RenewalsSectionTabsWithCountsProps {
  readonly tenantSlug: string;
  /**
   * Forwarded to `RenewalsSectionTabs` — the tap-discoverable pipeline help
   * Popover renders only on the Pipeline + Pending-review views; the Tasks /
   * Tier-upgrades pages render the bare strip.
   */
  readonly showPipelineHelp?: boolean;
}

export async function RenewalsSectionTabsWithCounts({
  tenantSlug,
  showPipelineHelp = false,
}: RenewalsSectionTabsWithCountsProps) {
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
      // Count only cycles still awaiting a decision. Cycles carrying the async
      // reject-with-refund marker are ALREADY decided (rejected; refund
      // settling) and render read-only, so counting them overstates the badge.
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
      showPipelineHelp={showPipelineHelp}
      pendingReviewCount={pendingReviewCount}
      tasksCount={tasksCount}
      tierUpgradeCount={tierUpgradeCount}
    />
  );
}
