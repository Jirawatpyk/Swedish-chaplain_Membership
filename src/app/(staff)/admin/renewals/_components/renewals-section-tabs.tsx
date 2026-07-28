/**
 * 070 F8 item #18 (extended, nav-orphans follow-up) — `RenewalsSectionTabs`.
 *
 * Section-level tab strip for the whole `/admin/renewals/**` surface: the
 * default urgency pipeline, the "Pending review" discovery list (cycles in
 * `pending_admin_reactivation` awaiting an admin approve/reject decision),
 * plus the two previously-orphaned sibling routes — Tasks
 * (`/admin/renewals/tasks`) and Tier upgrades
 * (`/admin/renewals/tier-upgrades`), which existed but had no visible link
 * into them (palette-only). Rendered at the top of all three pages so an
 * admin can move between them without a second row of nav and without a
 * sidebar entry (a sidebar entry would double-highlight the Renewals
 * sidebar item's prefix `activePattern` — intentionally not added here).
 *
 * Renamed from `RenewalsViewTabs` (which only toggled the `?view=` query
 * param on `/admin/renewals`) because it now also *navigates* to two
 * entirely different routes — "view toggle" stopped being an accurate name.
 *
 * Active tab is derived from `usePathname()` + `useSearchParams()` rather
 * than a prop passed down from each server component — a single source of
 * truth that can never drift from the URL, reused unchanged across all
 * three call sites:
 *   - `/admin/renewals` (no `view`)             → Pipeline
 *   - `/admin/renewals?view=pending-review`     → Pending review
 *   - pathname starts `/admin/renewals/tasks`         → Tasks
 *   - pathname starts `/admin/renewals/tier-upgrades` → Tier upgrades
 *
 * Selecting Pipeline/Pending-review pushes `/admin/renewals` (optionally
 * with `?view=pending-review`), inheriting the pipeline's own query params
 * (tier/urgency/cursor/month/nowIso) ONLY when already on that route —
 * arriving from Tasks/Tier-upgrades starts a clean pipeline URL instead of
 * dragging along that page's unrelated filter params (status/assignment/
 * task_type/etc). Selecting Tasks/Tier-upgrades is a plain route push.
 */
'use client';

import { HelpCircleIcon } from 'lucide-react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const RENEWALS_BASE = '/admin/renewals';
const TASKS_PATH = '/admin/renewals/tasks';
const TIER_UPGRADES_PATH = '/admin/renewals/tier-upgrades';

const PIPELINE_VALUE = 'pipeline';
const PENDING_REVIEW_VALUE = 'pending-review';
const TASKS_VALUE = 'tasks';
const TIER_UPGRADES_VALUE = 'tier-upgrades';

type SectionTab =
  | typeof PIPELINE_VALUE
  | typeof PENDING_REVIEW_VALUE
  | typeof TASKS_VALUE
  | typeof TIER_UPGRADES_VALUE;

function deriveCurrentTab(
  pathname: string,
  viewParam: string | null,
): SectionTab {
  if (pathname.startsWith(TASKS_PATH)) return TASKS_VALUE;
  if (pathname.startsWith(TIER_UPGRADES_PATH)) return TIER_UPGRADES_VALUE;
  return viewParam === PENDING_REVIEW_VALUE
    ? PENDING_REVIEW_VALUE
    : PIPELINE_VALUE;
}

export interface RenewalsSectionTabsProps {
  /**
   * Tap-discoverable help explaining what the pipeline lists — only
   * meaningful on the Renewals page (Pipeline + Pending-review views).
   * The Tasks / Tier-upgrades pages render the bare strip.
   */
  readonly showPipelineHelp?: boolean;
  /**
   * Item ④ — count of cycles in `pending_admin_reactivation`; badge shown
   * only when `> 0`.
   */
  readonly pendingReviewCount?: number;
  /**
   * Item ④ (plan-wide decision) — count of open escalation tasks; badge
   * shown only when `> 0`.
   */
  readonly tasksCount?: number;
  /**
   * Item ④ (plan-wide decision) — count of open + accepted-pending-apply
   * tier-upgrade suggestions; badge shown only when `> 0`.
   */
  readonly tierUpgradeCount?: number;
}

/**
 * Item ④ — visible count pill + sr-only text, shared by the Pending-review
 * / Tasks / Tier-upgrades tab triggers (deliberately NOT the Pipeline tab —
 * that's the default view, not a work queue). Renders nothing when `count`
 * is `0` or `undefined` so an empty section never shows a hollow badge.
 * Styling mirrors `UrgencyBucketTabs`' per-bucket count badge.
 *
 * Exported (review round 1, Fix I-1) — `/admin/renewals` `page.tsx` reuses
 * this exact idiom for the `WorkQueueTabs` "Needs action" tab badge instead
 * of duplicating the pill markup. `page.tsx` renders it from a Server
 * Component (`NeedsActionCountBadge`); this module carries `'use client'`
 * but has no interactivity of its own, so a Server Component rendering it
 * directly is a normal Server→Client composition (same shape as `pipeline`
 * / `needsAction` already being server-streamed `ReactNode` props into the
 * client `WorkQueueTabs`).
 */
export function TabCountBadge({
  count,
  label,
}: {
  readonly count: number | undefined;
  readonly label: string;
}) {
  if (count === undefined || count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary/10 px-1.5 text-xs font-medium tabular-nums text-primary ring-1 ring-inset ring-primary/20"
      >
        {count}
      </span>
      <span className="sr-only"> {label}</span>
    </>
  );
}

export function RenewalsSectionTabs({
  showPipelineHelp = false,
  pendingReviewCount,
  tasksCount,
  tierUpgradeCount,
}: RenewalsSectionTabsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('admin.renewals');

  const current = deriveCurrentTab(pathname, params.get('view'));

  function handleChange(value: string) {
    if (value === TASKS_VALUE) {
      router.push(TASKS_PATH);
      return;
    }
    if (value === TIER_UPGRADES_VALUE) {
      router.push(TIER_UPGRADES_PATH);
      return;
    }
    if (value !== PIPELINE_VALUE && value !== PENDING_REVIEW_VALUE) return;

    // Only inherit the pipeline's own query params when already on the
    // pipeline route — arriving FROM Tasks/Tier-upgrades starts a clean
    // pipeline URL instead of carrying that page's unrelated params.
    const next = new URLSearchParams(
      pathname === RENEWALS_BASE ? params.toString() : '',
    );
    // Switching view resets the pipeline-only filter state.
    next.delete('cursor');
    if (value === PENDING_REVIEW_VALUE) {
      next.delete('urgency');
      next.delete('tier');
      next.set('view', PENDING_REVIEW_VALUE);
    } else {
      next.delete('view');
    }
    const qs = next.toString();
    router.push(qs.length > 0 ? `${RENEWALS_BASE}?${qs}` : RENEWALS_BASE);
  }

  return (
    <div className="flex items-center gap-1.5">
      <Tabs value={current} onValueChange={handleChange}>
        <TabsList aria-label={t('tabs.ariaLabel')}>
          <TabsTrigger value={PIPELINE_VALUE}>{t('tabs.pipeline')}</TabsTrigger>
          <TabsTrigger value={PENDING_REVIEW_VALUE}>
            {t('pendingReview.tab')}
            <TabCountBadge
              count={pendingReviewCount}
              label={t('pendingReview.tabCountSr', {
                count: pendingReviewCount ?? 0,
              })}
            />
          </TabsTrigger>
          <TabsTrigger value={TASKS_VALUE}>
            {t('tabs.tasks')}
            <TabCountBadge
              count={tasksCount}
              label={t('tabs.tasksCountSr', { count: tasksCount ?? 0 })}
            />
          </TabsTrigger>
          <TabsTrigger value={TIER_UPGRADES_VALUE}>
            {t('tabs.tierUpgrades')}
            <TabCountBadge
              count={tierUpgradeCount}
              label={t('tabs.tierUpgradesCountSr', {
                count: tierUpgradeCount ?? 0,
              })}
            />
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* Tap-discoverable help explaining what the pipeline lists. A Popover
          (not a hover Tooltip) so it works on touch — same pattern as
          `company-section.tsx`. Placed BESIDE the tab strip, never nested in a
          TabsTrigger (which would break the tablist's roving-tabindex a11y).
          Renewals page only (showPipelineHelp) — Tasks/Tier-upgrades render
          just the strip. */}
      {showPipelineHelp ? (
        <Popover>
          <PopoverTrigger
            type="button"
            aria-label={t('pipelineHelp.ariaLabel')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HelpCircleIcon className="size-4" aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            className="w-80 max-w-[calc(100vw-2rem)] text-sm"
            sideOffset={4}
          >
            <p className="font-medium">{t('pipelineHelp.title')}</p>
            <p className="mt-1.5 text-muted-foreground">
              {t('pipelineHelp.body')}
            </p>
            <dl className="mt-2 space-y-1.5">
              <div>
                <dt className="font-medium text-foreground">
                  {t('pipelineHelp.suspendedTerm')}
                </dt>
                <dd className="text-muted-foreground">
                  {t('pipelineHelp.suspendedDef')}
                </dd>
              </div>
              <div>
                <dt className="font-medium text-foreground">
                  {t('pipelineHelp.terminatedTerm')}
                </dt>
                <dd className="text-muted-foreground">
                  {t('pipelineHelp.terminatedDef')}
                </dd>
              </div>
            </dl>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
