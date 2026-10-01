/**
 * 070 F8 item #18 (extended, nav-orphans follow-up) — `RenewalsSectionTabs`.
 *
 * Section-level navigation for the whole `/admin/renewals/**` surface: the
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
 * 122 US7a (T703): AURA link tabs on a desktop (board `Admin-renewals`) —
 * a `nav` of links with `aria-current="page"`, not an ARIA tablist, as these
 * entries navigate — and a "Section" select on a phone (board
 * `Admin-renewals-mobile`) that navigates to the same hrefs. The pipeline
 * help moved to the work-queue toggle row, where the board draws it.
 *
 * Active entry is derived from `usePathname()` + `useSearchParams()` rather
 * than a prop passed down from each server component — a single source of
 * truth that can never drift from the URL, reused unchanged across all
 * three call sites:
 *   - `/admin/renewals` (no `view`)             → Pipeline
 *   - `/admin/renewals?view=pending-review`     → Pending review
 *   - pathname starts `/admin/renewals/tasks`         → Tasks
 *   - pathname starts `/admin/renewals/tier-upgrades` → Tier upgrades
 *
 * The Pipeline / Pending-review hrefs point at `/admin/renewals` (optionally
 * with `?view=pending-review`), inheriting the pipeline's own query params
 * (tier/urgency/cursor/month/nowIso) ONLY when already on that route —
 * arriving from Tasks/Tier-upgrades starts a clean pipeline URL instead of
 * dragging along that page's unrelated filter params (status/assignment/
 * task_type/etc). Tasks/Tier-upgrades are plain route hrefs; the active
 * entry keeps the current URL (its own filters).
 */
'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Select, Tabs, type TabItem } from '@jirawatpyk/aura-react';

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

/**
 * Pure href builder for the Pipeline / Pending-review entries — the same URL
 * the old `handleChange` `router.push`ed, now expressed as a link `href`.
 *
 * Only inherit the pipeline's own query params when already ON the pipeline
 * route — arriving FROM Tasks/Tier-upgrades starts a CLEAN pipeline URL
 * instead of carrying that page's unrelated params. Switching view always
 * resets the pipeline-only pagination cursor; Pending-review additionally
 * drops the pipeline-only `urgency`/`tier` filters (it has no such filters)
 * and sets `view=pending-review`, while Pipeline drops `view`.
 */
function buildPipelineHref(
  pathname: string,
  params: URLSearchParams,
  target: typeof PIPELINE_VALUE | typeof PENDING_REVIEW_VALUE,
): string {
  const next = new URLSearchParams(
    pathname === RENEWALS_BASE ? params.toString() : '',
  );
  next.delete('cursor');
  if (target === PENDING_REVIEW_VALUE) {
    next.delete('urgency');
    next.delete('tier');
    next.set('view', PENDING_REVIEW_VALUE);
  } else {
    next.delete('view');
  }
  const qs = next.toString();
  return qs.length > 0 ? `${RENEWALS_BASE}?${qs}` : RENEWALS_BASE;
}

/**
 * Ported from `src/components/ui/tabs.tsx` so the nav renders pixel-identically
 * to the old Base UI tab strip (this component no longer uses the primitive).
 *
 * - `NAV_LIST` = `tabsListVariants` (default variant) resolved for a fixed
 *   horizontal orientation: the `group-data-horizontal/tabs:h-8` track height,
 *   `bg-muted`, `rounded-lg p-[3px]` padding. Vertical / line-variant branches
 *   and the `group/tabs` wrapper are dropped (never reachable here).
 * - `NAV_LINK_BASE` = the `TabsTrigger` geometry + typography + focus ring,
 *   with the inactive/active colour split pulled out (see below) and the
 *   inert-here helpers dropped (`disabled:`/`aria-disabled:` — a link is never
 *   disabled; `[&_svg]`/`has-data-[icon]` — no icon descendant; the default
 *   variant's always-`opacity-0` `after:` indicator).
 * - `NAV_LINK_INACTIVE` / `NAV_LINK_ACTIVE` — the primitive drove the pill from
 *   its `data-active` attribute (`data-active:text-foreground` outranking the
 *   base `text-muted-foreground` via selector specificity). A conditional class
 *   toggle has no such specificity edge, so the two text colours are made
 *   mutually exclusive here to guarantee the identical result regardless of
 *   Tailwind's utility sort order.
 */
export interface RenewalsSectionTabsProps {
  /** Item ④ — pending work per section, streamed in by `RenewalsSectionTabsWithCounts`. */
  readonly pendingReviewCount?: number;
  readonly tasksCount?: number;
  readonly tierUpgradeCount?: number;
  /**
   * The route the strip is on, when it is not the browser's: the no-DB preview
   * (`/test-fixtures/aura-admin`) renders each renewals page at its real path.
   * Pages leave it out.
   */
  readonly pathname?: string;
}

export function RenewalsSectionTabs({
  pendingReviewCount,
  tasksCount,
  tierUpgradeCount,
  pathname: pathnameOverride,
}: RenewalsSectionTabsProps) {
  const browserPathname = usePathname();
  const pathname = pathnameOverride ?? browserPathname;
  const params = useSearchParams();
  const router = useRouter();
  const t = useTranslations('admin.renewals');

  const current = deriveCurrentTab(pathname, params.get('view'));

  const search = params.toString();
  const currentUrl = search.length > 0 ? `${pathname}?${search}` : pathname;
  const hrefFor = (tab: SectionTab): string => {
    if (tab === current) return currentUrl;
    if (tab === TASKS_VALUE) return TASKS_PATH;
    if (tab === TIER_UPGRADES_VALUE) return TIER_UPGRADES_PATH;
    return buildPipelineHref(pathname, params, tab);
  };

  // Item ④ — a count only when there is pending work (the Pipeline entry is
  // the default view, never counted). The link's name carries the count's
  // meaning, starting with the visible label (WCAG 2.5.3).
  const counted = (
    id: SectionTab,
    label: string,
    count: number | undefined,
    countSr: string,
  ): TabItem => ({
    id,
    label,
    href: hrefFor(id),
    ...(count !== undefined && count > 0
      ? { count, tabProps: { 'aria-label': `${label}, ${countSr}` } }
      : {}),
  });

  const tabs: TabItem[] = [
    { id: PIPELINE_VALUE, label: t('tabs.pipeline'), href: hrefFor(PIPELINE_VALUE) },
    counted(
      PENDING_REVIEW_VALUE,
      t('pendingReview.tab'),
      pendingReviewCount,
      t('pendingReview.tabCountSr', { count: pendingReviewCount ?? 0 }),
    ),
    counted(
      TASKS_VALUE,
      t('tabs.tasks'),
      tasksCount,
      t('tabs.tasksCountSr', { count: tasksCount ?? 0 }),
    ),
    counted(
      TIER_UPGRADES_VALUE,
      t('tabs.tierUpgrades'),
      tierUpgradeCount,
      t('tabs.tierUpgradesCountSr', { count: tierUpgradeCount ?? 0 }),
    ),
  ];

  return (
    <>
      <Tabs
        label={t('tabs.ariaLabel')}
        tabs={tabs}
        value={current}
        className="max-sm:hidden"
      />
      {/* The phone board draws the sections as a select; choosing one goes
          to the same href as its tab. */}
      <div className="sm:hidden">
        <Select
          label={t('tabs.selectLabel')}
          value={current}
          options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
          onChange={(e) => {
            const next = tabs.find((tab) => tab.id === e.target.value);
            if (next?.href) router.push(next.href);
          }}
        />
      </div>
    </>
  );
}
