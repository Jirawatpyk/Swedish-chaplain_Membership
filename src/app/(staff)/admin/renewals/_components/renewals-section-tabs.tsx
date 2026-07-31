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
 * These entries NAVIGATE to different routes/URLs, so they are real
 * navigation `<Link>`s inside a `<nav>` landmark — NOT an ARIA tablist
 * (whole-branch review #9, a11y-correctness fix). A prior version rendered
 * a Base UI `<Tabs><TabsList><TabsTrigger>` (`role="tablist"`/`role="tab"` +
 * `aria-selected`) even though there was never a `role="tabpanel"` for the
 * "tabs" to control — a dangling tab role that made screen readers announce
 * "tab, selected" for what are really page links. The rendered appearance is
 * unchanged: the link markup ports the exact `TabsList`/`TabsTrigger` styling
 * (see `src/components/ui/tabs.tsx`), and the active link replicates the
 * active-pill look (`bg-background text-foreground shadow-sm` +
 * dark-mode variants) that the primitive drove from its `data-active` state.
 *
 * Renamed from `RenewalsViewTabs` (which only toggled the `?view=` query
 * param on `/admin/renewals`) because it now also *navigates* to two
 * entirely different routes — "view toggle" stopped being an accurate name.
 * (The `SectionTabs` name is kept for continuity across the three call sites
 * and the `TabCountBadge` reused by `page.tsx`'s `WorkQueueTabs`.)
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
 * The active entry carries `aria-current="page"`; the others carry nothing.
 *
 * The Pipeline / Pending-review hrefs point at `/admin/renewals` (optionally
 * with `?view=pending-review`), inheriting the pipeline's own query params
 * (tier/urgency/cursor/month/nowIso) ONLY when already on that route —
 * arriving from Tasks/Tier-upgrades starts a clean pipeline URL instead of
 * dragging along that page's unrelated filter params (status/assignment/
 * task_type/etc). Tasks/Tier-upgrades are plain route hrefs. Each href is
 * computed once per render by the pure `buildPipelineHref` helper below.
 */
'use client';

import { HelpCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
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
 *   base `text-foreground/60` via selector specificity). A conditional class
 *   toggle has no such specificity edge, so the two text colours are made
 *   mutually exclusive here to guarantee the identical result regardless of
 *   Tailwind's utility sort order.
 */
const NAV_LIST =
  'inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-muted-foreground pointer-coarse:h-auto';

const NAV_LINK_BASE =
  "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring pointer-coarse:min-h-11";

const NAV_LINK_INACTIVE =
  'text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground';

const NAV_LINK_ACTIVE =
  'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground';

function navLinkClass(isActive: boolean): string {
  return cn(NAV_LINK_BASE, isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE);
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
 * / Tasks / Tier-upgrades entries (deliberately NOT the Pipeline entry —
 * that's the default view, not a work queue). Renders nothing when `count`
 * is `0` or `undefined` so an empty section never shows a hollow badge.
 * Styling mirrors `UrgencyBucketTabs`' per-bucket count badge.
 *
 * Exported (review round 1, Fix I-1) — `/admin/renewals` `page.tsx` reuses
 * this exact idiom for the `WorkQueueTabs` "Needs action" tab badge instead
 * of duplicating the pill markup. `page.tsx` renders it from a Server
 * Component (`NeedsActionCountBadge`); this module carries `'use client'`
 * but `TabCountBadge` has no interactivity of its own, so a Server Component
 * rendering it directly is a normal Server→Client composition.
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
  const pathname = usePathname();
  const params = useSearchParams();
  const t = useTranslations('admin.renewals');

  const current = deriveCurrentTab(pathname, params.get('view'));

  // Four hrefs computed once per render from the current pathname/params.
  // Pipeline/Pending-review inherit the pipeline's params only when on the
  // pipeline route (see `buildPipelineHref`); Tasks/Tier-upgrades are plain.
  const pipelineHref = buildPipelineHref(pathname, params, PIPELINE_VALUE);
  const pendingReviewHref = buildPipelineHref(
    pathname,
    params,
    PENDING_REVIEW_VALUE,
  );

  return (
    <div className="flex items-center gap-1.5">
      {/* C2 (#4) — horizontal-scroll container. The `inline-flex w-fit` nav
          with four `whitespace-nowrap` links overflows a narrow viewport;
          scrolling it inside its OWN `overflow-x-auto` box keeps the page body
          from scrolling horizontally (ux-standards § 9.1) and keeps the help
          Popover trigger (rendered as a sibling below, NOT inside this box)
          always reachable. `min-w-0` lets the box shrink below its content
          width so the overflow actually engages inside a flex row; the
          `-my-1 py-1` bleed gives the focus ring vertical room, and
          `overflow-y-hidden` suppresses the phantom vertical scrollbar/chevron
          that `overflow-x: auto` would otherwise coerce to `auto` — same fix as
          the sibling `urgency-bucket-tabs`. The negative margin keeps the
          strip's outer height unchanged. No `tabIndex`/`role="region"` is
          needed on this scroll box: it wraps a `<nav>` whose `<Link>`s are
          natively focusable, so WCAG 2.1.1 (scrollable-region-focusable) is
          satisfied via focusable descendants. */}
      <div className="-my-1 min-w-0 overflow-x-auto overflow-y-hidden py-1">
        {/* Navigation landmark (NOT an ARIA tablist) — these entries navigate
            to different routes/URLs, so they are real links. Four links → Tab
            focuses them in order, no roving/arrow handling needed; native
            Enter/click navigates. `aria-current="page"` marks the active one.
            C2 (#4): the track grows to fit the >=44px coarse-pointer links
            (`pointer-coarse:h-auto`) so the active pill can't overflow the
            default `h-8` track top/bottom on touch; desktop stays h-8. */}
        <nav aria-label={t('tabs.ariaLabel')} className={NAV_LIST}>
          <Link
            href={pipelineHref}
            aria-current={current === PIPELINE_VALUE ? 'page' : undefined}
            className={navLinkClass(current === PIPELINE_VALUE)}
          >
            {t('tabs.pipeline')}
          </Link>
          <Link
            href={pendingReviewHref}
            aria-current={
              current === PENDING_REVIEW_VALUE ? 'page' : undefined
            }
            className={navLinkClass(current === PENDING_REVIEW_VALUE)}
          >
            {t('pendingReview.tab')}
            <TabCountBadge
              count={pendingReviewCount}
              label={t('pendingReview.tabCountSr', {
                count: pendingReviewCount ?? 0,
              })}
            />
          </Link>
          <Link
            href={TASKS_PATH}
            aria-current={current === TASKS_VALUE ? 'page' : undefined}
            className={navLinkClass(current === TASKS_VALUE)}
          >
            {t('tabs.tasks')}
            <TabCountBadge
              count={tasksCount}
              label={t('tabs.tasksCountSr', { count: tasksCount ?? 0 })}
            />
          </Link>
          <Link
            href={TIER_UPGRADES_PATH}
            aria-current={current === TIER_UPGRADES_VALUE ? 'page' : undefined}
            className={navLinkClass(current === TIER_UPGRADES_VALUE)}
          >
            {t('tabs.tierUpgrades')}
            <TabCountBadge
              count={tierUpgradeCount}
              label={t('tabs.tierUpgradesCountSr', {
                count: tierUpgradeCount ?? 0,
              })}
            />
          </Link>
        </nav>
      </div>
      {/* Tap-discoverable help explaining what the pipeline lists. A Popover
          (not a hover Tooltip) so it works on touch — same pattern as
          `company-section.tsx`. Placed BESIDE the nav strip, never nested in a
          link. Renewals page only (showPipelineHelp) — Tasks/Tier-upgrades
          render just the strip. */}
      {showPipelineHelp ? (
        <Popover>
          <PopoverTrigger
            type="button"
            aria-label={t('pipelineHelp.ariaLabel')}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-9"
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
