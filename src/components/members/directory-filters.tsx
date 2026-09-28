'use client';

/**
 * Members directory filters with URL-state sync.
 *
 * URL is the source of truth (bookmarkable). Filters:
 *   - Search (q): debounced 300ms text input
 *   - Status: select (All / Active / Inactive / Archived)
 *   - Plan: select (All plans / dynamic list from F2)
 *   - Risk band: select
 *   - Needs portal invite: toggle chip with the count
 *   - Clear filters: resets all filters + pagination
 *
 * 122 US5a (T503) — AURA `FilterBar` (board `Admin-members`): the search and
 * the selects in one bar, the applied filters as removable tags below it with
 * "Clear filters". The URL contract is unchanged. Each select is the board's
 * compact "Status All ▾" trigger (`FilterChipSelect`).
 */

import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AuraProvider, Button, FilterBar, Tag } from '@jirawatpyk/aura-react';
import { FilterChipSelect } from './filter-chip-select';
import { formatCalendarYear } from '@/lib/format-date-localised';
import { MailWarningIcon } from 'lucide-react';

const DEBOUNCE_MS = 300;

const STATUS_VALUES = ['active', 'inactive', 'archived'] as const;
const RISK_BANDS = ['healthy', 'warning', 'at-risk', 'critical'] as const;

// i18n key maps hoisted to module scope so they are not rebuilt on every render.
const STATUS_LABEL_KEYS: Record<string, string> = {
  all: 'filters.status.all',
  active: 'filters.status.active',
  inactive: 'filters.status.inactive',
  archived: 'filters.status.archived',
};
const RISK_LABEL_KEYS: Record<string, string> = {
  all: 'filters.risk.all',
  healthy: 'filters.risk.healthy',
  warning: 'filters.risk.warning',
  'at-risk': 'filters.risk.at-risk',
  critical: 'filters.risk.critical',
};

type ChipId = 'q' | 'status' | 'plan' | 'risk';

/** The URL params each active-filter chip clears (plan also drops its year). */
const CHIP_CLEARS: Readonly<Record<ChipId, Record<string, null>>> = {
  q: { q: null },
  status: { status: null },
  plan: { plan_id: null, plan_year: null },
  risk: { risk_band: null },
};

export type PlanOption = {
  readonly id: string;
  readonly label: string;
};

type Props = {
  readonly plans?: readonly PlanOption[];
  /**
   * Members matching the current filters that still need a portal invite.
   * `null` = the count could not be read; the chip renders disabled rather
   * than claiming zero (an absent chip means "no work left").
   */
  readonly portalInviteCount?: number | null;
};

export function DirectoryFilters({ plans = [], portalInviteCount }: Props) {
  const t = useTranslations('admin.members.directory');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const barRef = useRef<HTMLDivElement>(null);
  // Stable focus target for when a control unmounts on its own click (the
  // needs-invite chip toggled off at zero, a removed filter tag, Clear
  // filters): the search input is always rendered.
  const focusSearch = () =>
    barRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  // A clear that drops the search remounts the FilterBar: it keeps the typed
  // text and its own debounce timer, so a query typed just before the clear
  // would otherwise come back when the timer fires. The new bar's search box
  // takes focus once it has mounted.
  const [barKey, setBarKey] = useState(0);
  const resetSearch = () => {
    setSentQ('');
    setBarKey((k) => k + 1);
    setTimeout(focusSearch, 0);
  };

  const currentQ = searchParams.get('q') ?? '';
  const currentStatus = searchParams.get('status') ?? 'all';
  const currentPlan = searchParams.get('plan_id') ?? 'all';
  // Set by the plan detail page's member-count link (one plan YEAR); there is
  // no Select for it — it shows on the plan chip and clears with the plan.
  const currentPlanYear = searchParams.get('plan_year');
  const currentRisk = searchParams.get('risk_band') ?? 'all';

  const portalActive = searchParams.get('portal') === 'needs_invite';
  // The chip is visible when there is work to show, the filter is on, or the
  // count could not be read (unavailable). Focus on toggle-off is handled
  // imperatively in `onPortalToggle`.
  const showChip =
    portalActive ||
    portalInviteCount === null ||
    (portalInviteCount ?? 0) > 0;

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // Clear pagination state whenever filters change.
      params.delete('cursor');
      params.delete('page');
      // Clean up legacy param
      params.delete('show_archived');
      const query = params.toString();
      startTransition(() => {
        // `scroll: false` — a filter change is an in-place refine, NOT a
        // navigation; the default scroll-to-top made the table "jump" on every
        // debounced keystroke.
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  // Toggle the needs-invite filter. When turning it OFF at count 0, the chip
  // unmounts in the same commit that processes the navigation — so move focus
  // to the always-present search input FIRST, or it falls back to <body> (a
  // focus-loss class axe never catches).
  function onPortalToggle() {
    const willUnmount = portalActive && portalInviteCount === 0;
    if (willUnmount) focusSearch();
    pushUrl({ portal: portalActive ? null : 'needs_invite' });
  }

  // Search. AURA's FilterBar keeps the typed draft and debounces it; it
  // rewrites the box from `search` only when `search` differs from the last
  // value it sent. The URL carries the TRIMMED query, so while the box is
  // focused we hand back exactly what it sent (`sentQ`) — a lagging or
  // trimmed URL can then never revert what the admin is typing. Unfocused
  // (back/forward, a shared link), the URL wins.
  const [sentQ, setSentQ] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const onSearchChange = (value: string) => {
    setSentQ(value);
    pushUrl({ q: value.trim() || null });
  };
  const isSearchInput = (el: EventTarget) =>
    el instanceof HTMLInputElement && el.type === 'search';

  const hasAnyFilter =
    Boolean(currentQ) ||
    currentStatus !== 'all' ||
    currentPlan !== 'all' ||
    currentRisk !== 'all' ||
    portalActive;
  const clearAll = () => {
    resetSearch();
    pushUrl({
      q: null,
      status: null,
      plan_id: null,
      plan_year: null,
      risk_band: null,
      portal: null,
    });
  };

  // Removing a chip unmounts it, so the × also moves focus to the search
  // input. Each chip reuses the same `pushUrl({ key: null })` clear the
  // controls use, so there is no new URL wiring.
  const removeChip = (id: ChipId) => {
    pushUrl(CHIP_CLEARS[id]);
    if (id === 'q') resetSearch();
    else focusSearch();
  };

  // Active-filter chips (ux-standards §9.4) — a consolidated, dismissible
  // summary of the applied filters.
  const chipLabels: Array<{ id: ChipId; label: string }> = [];
  if (currentQ) chipLabels.push({ id: 'q', label: t('filterChip.search', { q: currentQ }) });
  if (currentStatus !== 'all') {
    const vk = STATUS_LABEL_KEYS[currentStatus];
    chipLabels.push({ id: 'status', label: t('filterChip.status', { value: vk ? t(vk) : currentStatus }) });
  }
  if (currentPlan !== 'all') {
    const plan = plans.find((p) => p.id === currentPlan);
    chipLabels.push({
      id: 'plan',
      label: currentPlanYear
        ? t('filterChip.planYear', {
            value: plan?.label ?? currentPlan,
            year: formatCalendarYear(Number(currentPlanYear), locale),
          })
        : t('filterChip.plan', { value: plan?.label ?? currentPlan }),
    });
  }
  if (currentRisk !== 'all') {
    const vk = RISK_LABEL_KEYS[currentRisk];
    chipLabels.push({ id: 'risk', label: t('filterChip.risk', { value: vk ? t(vk) : currentRisk }) });
  }
  const activeChips = chipLabels.map((c) => ({ ...c, onRemove: () => removeChip(c.id) }));

  // The bar's own "Clear filters" and chip × labels, in this page's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: t('clearFilters'),
      remove: (label: string) => t('removeFilter', { filter: label }),
    }),
    [t],
  );

  return (
    <div
      onFocus={(e) => {
        if (isSearchInput(e.target)) setIsSearchFocused(true);
      }}
      onBlur={(e) => {
        if (isSearchInput(e.target)) setIsSearchFocused(false);
      }}
    >
      <AuraProvider strings={barStrings}>
        <FilterBar
          key={barKey}
          ref={barRef}
          // As on the `Admin-members` boards: from 1024px the search fills the
          // row beside the filters; below it the search takes its own row and
          // the filters share the next; on a phone the three filters share one
          // row (6px apart, each as wide as its words) and the needs-invite
          // chip wraps to the next. The search width reaches into AURA's
          // FilterBar classes: a stand-in until AURA #83 (searchFill).
          className="[&_.aura-filterbar\_\_search]:max-w-none [&_.aura-filterbar\_\_spacer]:hidden max-lg:[&_.aura-filterbar\_\_search]:basis-full max-sm:[&_.aura-filterbar\_\_controls]:w-full max-sm:[&_.aura-filterbar\_\_controls]:gap-1.5"
          search={isSearchFocused ? sentQ : currentQ}
          onSearchChange={onSearchChange}
          searchDelay={DEBOUNCE_MS}
          searchLabel={t('searchSrLabel')}
          searchPlaceholder={t('searchPlaceholder')}
          filters={activeChips}
          {...(hasAnyFilter ? { onClearAll: clearAll } : {})}
        >
          <FilterChipSelect
            label={t('filters.status.label')}
            allLabel={t('filters.allShort')}
            value={currentStatus}
            onChange={(v) => pushUrl({ status: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: t('filters.status.all') },
              ...STATUS_VALUES.map((s) => ({ value: s, label: t(`filters.status.${s}`) })),
            ]}
          />

          {plans.length > 0 && (
            <FilterChipSelect
              label={t('filters.plan.label')}
              allLabel={t('filters.allShort')}
              value={currentPlan}
              // A new plan pick drops a year that belonged to the previous plan.
              onChange={(v) => pushUrl({ plan_id: v === 'all' ? null : v, plan_year: null })}
              options={[
                { value: 'all', label: t('filters.plan.all') },
                ...plans.map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
          )}

          {/* I1 round-10 ui-design-specialist — quick filter on the
              F8-derived risk band, so renewal triage can scan "at-risk" and
              "critical" members in one click. */}
          <FilterChipSelect
            label={t('filters.risk.label')}
            allLabel={t('filters.allShort')}
            value={currentRisk}
            onChange={(v) => pushUrl({ risk_band: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: t('filters.risk.all') },
              ...RISK_BANDS.map((b) => ({ value: b, label: t(`filters.risk.${b}`) })),
            ]}
          />

          {showChip && (
            <Tag
              icon={<MailWarningIcon aria-hidden="true" />}
              selected={portalActive}
              onClick={onPortalToggle}
              // Disable only when the count is unavailable AND the filter is
              // OFF — the user would be entering the filter blind. When the
              // filter is already ON, a failed count must NOT trap them in the
              // filtered view: the chip stays clickable so they can toggle off.
              disabled={portalInviteCount === null && !portalActive}
              aria-label={
                portalInviteCount === null
                  ? t('portalChip.unavailable')
                  : t('portalChip.aria', { count: portalInviteCount ?? 0 })
              }
              // Hover hint on the unavailable state so it reads as a transient
              // read failure ("refresh to try again"), not an empty count.
              {...(portalInviteCount === null ? { title: t('portalChip.unavailableHint') } : {})}
            >
              {/* Visible text echoes the accessible name (WCAG 2.5.3 Label in
                  Name): when the count is unavailable, the SAME copy. */}
              {portalInviteCount === null
                ? t('portalChip.unavailable')
                : `${t('portalChip.label')} · ${portalInviteCount}`}
            </Tag>
          )}

          {/* The needs-invite toggle is not repeated as a chip below (one
              control, one name), so when it is the ONLY filter applied the
              bar's own "Clear filters" (chips row) is absent: offer it here. */}
          {portalActive && activeChips.length === 0 && (
            <Button variant="ghost" size="sm" icon="x" onClick={clearAll}>
              {t('clearFilters')}
            </Button>
          )}
        </FilterBar>
      </AuraProvider>
    </div>
  );
}
