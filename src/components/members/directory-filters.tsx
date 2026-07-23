'use client';

/**
 * Members directory filters with URL-state sync.
 *
 * URL is the source of truth (bookmarkable). Filters:
 *   - Search (q): debounced 300ms text input
 *   - Status: Select dropdown (All / Active / Inactive / Archived)
 *   - Plan: Select dropdown (All plans / dynamic list from F2)
 *   - Clear: resets all filters + pagination
 */

import { useCallback, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MailWarningIcon, SearchIcon, XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable focus target for when the chip unmounts on its own toggle-off (see
  // `onPortalToggle`). The search input is always rendered.
  const searchInputRef = useRef<HTMLInputElement>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentStatus = searchParams.get('status') ?? 'all';
  const currentPlan = searchParams.get('plan_id') ?? 'all';
  const currentRisk = searchParams.get('risk_band') ?? 'all';

  const portalActive = searchParams.get('portal') === 'needs_invite';
  // The chip is visible when there is work to show, the filter is on, or the
  // count could not be read (unavailable). A `chipWasVisible` latch used to
  // live here to "keep the chip mounted for the render it was clicked off" —
  // it was removed because it can't work: React's adjust-state-during-render
  // collapses the would-be one extra frame before commit, so the latch was
  // provably always equal to this expression and never painted a difference.
  // Focus on toggle-off is handled imperatively in `onPortalToggle` instead.
  const showChip =
    portalActive ||
    portalInviteCount === null ||
    (portalInviteCount ?? 0) > 0;

  // Toggle the needs-invite filter. When turning it OFF at count 0, the chip
  // unmounts in the same commit that processes the navigation — so move focus
  // to the always-present search input FIRST, or it falls back to <body> (a
  // focus-loss class axe never catches). `pushUrl` handles the URL + reset.
  function onPortalToggle() {
    const willUnmount = portalActive && portalInviteCount === 0;
    if (willUnmount) searchInputRef.current?.focus();
    pushUrl({ portal: portalActive ? null : 'needs_invite' });
  }

  // The search box is a CONTROLLED input (Base UI's FieldControl warns on
  // uncontrolled defaultValue being mutated — the previous `key={currentQ}` +
  // manual `ref.value =` approaches both fought it and dropped focus mid-type).
  // `searchValue` holds what the user typed; the debounce below syncs it to
  // the URL. We reconcile FROM the URL only when the input is NOT focused
  // (browser back/forward, a shared link, the Clear button) — never mid-type,
  // so fast typing can't be reverted to an in-flight debounced value.
  //
  // This reconcile is the React "adjust state when a prop changes" pattern,
  // done DURING RENDER (guarded by the `syncedQ` tracker) rather than in an
  // effect — so there is no cascading re-render and no `key`-based remount
  // (the remount was the original focus-drop bug). Focus is tracked as state
  // via onFocus/onBlur so the render stays pure (no `document.activeElement`
  // read during render, which would be non-deterministic and SSR-unsafe).
  const [searchValue, setSearchValue] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [syncedQ, setSyncedQ] = useState(currentQ);
  if (currentQ !== syncedQ) {
    setSyncedQ(currentQ);
    if (!isSearchFocused) setSearchValue(currentQ);
  }

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

  const onSearchChange = (value: string) => {
    setSearchValue(value); // controlled — reflect the keystroke immediately
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    Boolean(currentQ) ||
    currentStatus !== 'all' ||
    currentPlan !== 'all' ||
    currentRisk !== 'all' ||
    // Without this the Clear button never renders when the chip is the only
    // active filter — and clearAll() below becomes unreachable.
    portalActive;
  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchValue('');
    pushUrl({ q: null, status: null, plan_id: null, risk_band: null, portal: null });
  };

  // Active-filter chips (ux-standards §9.4) — a consolidated, dismissible summary
  // of the filters currently hidden inside the Selects (q / status / plan / risk).
  // The needs-invite chip stays its own toggle above; it is NOT duplicated here.
  // Each chip reuses the same `pushUrl({ key: null })` clear the Selects use, so
  // there is no new URL wiring.
  const activeChips: { key: string; label: string; onRemove: () => void }[] = [];
  if (currentQ) {
    activeChips.push({
      key: 'q',
      label: t('filterChip.search', { q: currentQ }),
      onRemove: () => {
        setSearchValue('');
        pushUrl({ q: null });
      },
    });
  }
  if (currentStatus !== 'all') {
    const vk = STATUS_LABEL_KEYS[currentStatus];
    activeChips.push({
      key: 'status',
      label: t('filterChip.status', { value: vk ? t(vk) : currentStatus }),
      onRemove: () => pushUrl({ status: null }),
    });
  }
  if (currentPlan !== 'all') {
    const plan = plans.find((p) => p.id === currentPlan);
    activeChips.push({
      key: 'plan',
      label: t('filterChip.plan', { value: plan?.label ?? currentPlan }),
      onRemove: () => pushUrl({ plan_id: null }),
    });
  }
  if (currentRisk !== 'all') {
    const vk = RISK_LABEL_KEYS[currentRisk];
    activeChips.push({
      key: 'risk',
      label: t('filterChip.risk', { value: vk ? t(vk) : currentRisk }),
      onRemove: () => pushUrl({ risk_band: null }),
    });
  }

  return (
    <div className="flex flex-col gap-2">
    <FilterBar>
      <div className="relative sm:flex-1 min-w-0">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchInputRef}
          type="search"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchSrLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <Select
        value={currentStatus}
        onValueChange={(v) => pushUrl({ status: v === 'all' ? null : v })}
      >
        <SelectTrigger className="sm:w-36" aria-label={t('filters.status.label')}>
          <TranslatedSelectValue
            placeholder={t('filters.status.label')}
            translate={(v) => {
              const key = STATUS_LABEL_KEYS[v || 'all'];
              return key ? t(key) : v;
            }}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.status.all')}</SelectItem>
          {STATUS_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`filters.status.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {plans.length > 0 && (
        <Select
          value={currentPlan}
          onValueChange={(v) => pushUrl({ plan_id: v === 'all' ? null : v })}
        >
          <SelectTrigger className="sm:w-56" aria-label={t('filters.plan.label')}>
            <TranslatedSelectValue
              placeholder={t('filters.plan.label')}
              translate={(v) => {
                if (!v || v === 'all') return t('filters.plan.all');
                const plan = plans.find((p) => p.id === v);
                return plan?.label ?? v;
              }}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('filters.plan.all')}</SelectItem>
            {plans.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* I1 round-10 ui-design-specialist — quick filter on F8-derived
          at-risk band. One of the marquee F3 smart features per docs/
          smart-chamber-features.md; until now it was visible in the
          column only. With this filter, admins doing renewal triage
          can scan all "at-risk" + "critical" members in one click. */}
      <Select
        value={currentRisk}
        onValueChange={(v) => pushUrl({ risk_band: v === 'all' ? null : v })}
      >
        <SelectTrigger
          className="sm:w-44"
          aria-label={t('filters.risk.label')}
        >
          <TranslatedSelectValue
            placeholder={t('filters.risk.label')}
            translate={(v) => {
              const key = RISK_LABEL_KEYS[v || 'all'];
              return key ? t(key) : v;
            }}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('filters.risk.all')}</SelectItem>
          {RISK_BANDS.map((b) => (
            <SelectItem key={b} value={b}>
              {t(`filters.risk.${b}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showChip && (
        <Button
          type="button"
          variant={portalActive ? 'secondary' : 'outline'}
          size="sm"
          aria-pressed={portalActive}
          // Disable only when the count is unavailable AND the filter is OFF —
          // i.e. the user would be entering the filter blind. When the filter is
          // already ON, a failed count must NOT trap them in the filtered view:
          // keep the chip clickable so they can always toggle it back off.
          disabled={portalInviteCount === null && !portalActive}
          // Toggles through `onPortalToggle` → `pushUrl` (strips cursor/page,
          // scroll:false) and moves focus off the chip before it can unmount.
          onClick={onPortalToggle}
          aria-label={
            portalInviteCount === null
              ? t('portalChip.unavailable')
              : t('portalChip.aria', { count: portalInviteCount ?? 0 })
          }
          // Hover hint on the unavailable state so it reads as a transient read
          // failure ("refresh to try again"), not a permanent empty count.
          {...(portalInviteCount === null
            ? { title: t('portalChip.unavailableHint') }
            : {})}
          className="whitespace-nowrap"
        >
          <MailWarningIcon className="size-4" aria-hidden />
          {/* Visible text must echo the accessible name (WCAG 2.5.3 Label in
              Name): when the count is unavailable, show the SAME "unavailable"
              copy the aria-label uses, not the generic label with no number. */}
          <span aria-hidden="true">
            {portalInviteCount === null
              ? t('portalChip.unavailable')
              : `${t('portalChip.label')} · ${portalInviteCount}`}
          </span>
        </Button>
      )}

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={clearAll}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" />
          {t('clearFilters')}
        </Button>
      )}
    </FilterBar>

    {activeChips.length > 0 && (
      <div className="flex flex-wrap items-center gap-2" aria-label={t('activeFilters')}>
        {activeChips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex items-center gap-1 rounded-md border bg-secondary py-0.5 pl-2 pr-1 text-xs text-secondary-foreground"
          >
            <span className="max-w-[24ch] truncate" title={chip.label}>
              {chip.label}
            </span>
            <button
              type="button"
              // Removing a chip unmounts it; move focus to the always-present
              // search input first so it never drops to <body> (mirrors
              // `onPortalToggle`'s focus handling).
              onClick={() => {
                chip.onRemove();
                searchInputRef.current?.focus();
              }}
              aria-label={t('removeFilter', { filter: chip.label })}
              className="rounded-sm p-0.5 hover:bg-secondary-foreground/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
    )}
    </div>
  );
}
