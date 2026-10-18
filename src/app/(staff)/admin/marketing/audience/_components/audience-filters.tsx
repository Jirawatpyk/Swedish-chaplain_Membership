'use client';

/**
 * 108 PR-D (FR-035) — Marketing audience filter bar. URL search params are
 * the single source of truth (shareable, back/forward-safe, and what the
 * server parses through `parseMarketingAudienceParams`); every change
 * resets `page`. Same shape as the members directory filters — including
 * the two lessons that file carries (review cycle 11, H1 / H2):
 *
 *   - the search box re-syncs FROM the URL only when it is not focused
 *     (Clear-filters CTA, the pre-flight preset, browser back/forward) —
 *     never mid-type;
 *   - "Clear filters" unmounts itself in the same commit as the navigation,
 *     so focus is moved to the always-present search input FIRST or it
 *     falls back to <body> (a focus-loss class axe never catches).
 *
 * Each select names itself with its label AND its current value so a
 * screen reader hears "Contact role: Secondary only", not just the label
 * (a11y review 7).
 *
 * Spec 122 US12a — AURA `FilterBar` in the global filter pattern: the search
 * in the bar, the three filters as `FilterSelect`s that move into the
 * "Filters (n)" sheet on phones, and each applied value as a removable chip
 * with "Clear filters". The chip labels reuse the "label: value" names, so
 * no new copy. The count stays the page's own line (`#audience-count`), the
 * focus target when the last row leaves a filtered view, so the bar gets no
 * `resultCount`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AuraProvider, Button, FilterBar, FilterSelect } from '@jirawatpyk/aura-react';
import { MARKETING_AUDIENCE_STATE_PARAMS } from '@/lib/marketing-audience-filter';

const DEBOUNCE_MS = 300;
const KIND_VALUES = ['primary', 'secondary'] as const;
type KindValue = 'all' | (typeof KIND_VALUES)[number];
type StateValue = 'all' | (typeof MARKETING_AUDIENCE_STATE_PARAMS)[number];
type EligibleValue = 'on' | 'off';

type ChipId = 'q' | 'kind' | 'state' | 'eligible';
/** The URL param each applied-filter chip clears. */
const CHIP_CLEARS: Readonly<Record<ChipId, Record<string, null>>> = {
  q: { q: null },
  kind: { kind: null },
  state: { state: null },
  eligible: { eligible: null },
};

export function AudienceFilters() {
  const t = useTranslations('admin.marketing.audience.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const barRef = useRef<HTMLDivElement>(null);
  const searchInput = (): HTMLInputElement | null =>
    barRef.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? null;
  // AURA's search box has no `enterKeyHint`; mobile keyboards should still
  // label their key "Search" (cycle 11).
  useEffect(() => {
    searchInput()?.setAttribute('enterkeyhint', 'search');
  });

  const currentQ = searchParams.get('q') ?? '';
  // NARROW, never cast (review M-3): the server parser drops unknown values,
  // so an unknown `?state=` / `?kind=` must read as "all" here too — a raw
  // key would otherwise land in the field text AND its accessible name.
  const rawKind = searchParams.get('kind');
  const currentKind: KindValue =
    rawKind !== null && (KIND_VALUES as readonly string[]).includes(rawKind)
      ? (rawKind as KindValue)
      : 'all';
  const rawState = searchParams.get('state');
  const currentState: StateValue =
    rawState !== null && (MARKETING_AUDIENCE_STATE_PARAMS as readonly string[]).includes(rawState)
      ? (rawState as StateValue)
      : 'all';
  const eligibleRaw = searchParams.get('eligible');
  const currentEligible: EligibleValue =
    eligibleRaw === '0' || eligibleRaw === 'false' ? 'off' : 'on';

  // AURA's FilterBar keeps the typed draft and debounces it (300 ms, and the
  // timer dies with the bar); it rewrites the box from `search` only when
  // `search` differs from what it last sent. While the box is focused we
  // hand back exactly what it sent, so a lagging or trimmed URL can never
  // revert what the admin is typing; unfocused, the URL wins.
  const [sentQ, setSentQ] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const isSearchTarget = (el: EventTarget) =>
    el instanceof HTMLInputElement && el.type === 'search';

  const pushUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      params.delete('page');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  const onSearchChange = (value: string) => {
    setSentQ(value);
    pushUrl({ q: value.trim() || null });
  };

  const hasAnyFilter =
    Boolean(currentQ) ||
    currentKind !== 'all' ||
    currentState !== 'all' ||
    currentEligible === 'off' ||
    searchParams.has('member_id');

  const clearAll = () => {
    // The Clear control unmounts in the commit that processes this
    // navigation — hand focus to the search input FIRST.
    searchInput()?.focus();
    setSentQ('');
    pushUrl({ q: null, kind: null, state: null, eligible: null, member_id: null });
  };

  const kindLabel = (v: KindValue) => t(`kind.${v}`);
  const stateLabel = (v: StateValue) => t(`state.${v}`);
  const eligibleLabel = (v: EligibleValue) => t(`eligible.${v}`);

  // One chip per applied value, named "label: value"; removing one moves
  // focus to the search input, since the chip unmounts with it.
  const removeChip = (id: ChipId) => {
    searchInput()?.focus();
    if (id === 'q') setSentQ('');
    pushUrl(CHIP_CLEARS[id]);
  };
  const chipDefs: Array<{ id: ChipId; label: string }> = [];
  if (currentQ) chipDefs.push({ id: 'q', label: `${t('searchLabel')}: ${currentQ}` });
  if (currentKind !== 'all') chipDefs.push({ id: 'kind', label: `${t('kindLabel')}: ${kindLabel(currentKind)}` });
  if (currentState !== 'all') chipDefs.push({ id: 'state', label: `${t('stateLabel')}: ${stateLabel(currentState)}` });
  if (currentEligible === 'off') {
    chipDefs.push({ id: 'eligible', label: `${t('eligibleLabel')}: ${eligibleLabel(currentEligible)}` });
  }
  const chips = chipDefs.map((c) => ({ ...c, onRemove: () => removeChip(c.id) }));

  const barStrings = useMemo(() => ({ clearFilters: t('clear') }), [t]);

  return (
    <div
      onFocus={(e) => {
        if (isSearchTarget(e.target)) setIsSearchFocused(true);
      }}
      onBlur={(e) => {
        if (isSearchTarget(e.target)) setIsSearchFocused(false);
      }}
    >
      <AuraProvider strings={barStrings}>
        <FilterBar
          ref={barRef}
          collapseBelow="sm"
          touchHeight
          searchGrow
          search={isSearchFocused ? sentQ : currentQ}
          onSearchChange={onSearchChange}
          searchDelay={DEBOUNCE_MS}
          searchLabel={t('searchLabel')}
          searchPlaceholder={t('searchPlaceholder')}
          filters={chips}
          // The phone "Filters (n)" button counts what is in the sheet, not
          // the search (it stays in the bar).
          filterCount={chips.length - (currentQ ? 1 : 0)}
          {...(hasAnyFilter ? { onClearAll: clearAll } : {})}
        >
          <FilterSelect
            label={t('kindLabel')}
            aria-label={`${t('kindLabel')}: ${kindLabel(currentKind)}`}
            value={currentKind}
            onChange={(v) => pushUrl({ kind: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: t('kind.all') },
              ...KIND_VALUES.map((k) => ({ value: k, label: t(`kind.${k}`) })),
            ]}
          />
          <FilterSelect
            label={t('stateLabel')}
            aria-label={`${t('stateLabel')}: ${stateLabel(currentState)}`}
            value={currentState}
            onChange={(v) => pushUrl({ state: v === 'all' ? null : v })}
            options={[
              { value: 'all', label: t('state.all') },
              ...MARKETING_AUDIENCE_STATE_PARAMS.map((s) => ({ value: s, label: t(`state.${s}`) })),
            ]}
          />
          <FilterSelect
            label={t('eligibleLabel')}
            aria-label={`${t('eligibleLabel')}: ${eligibleLabel(currentEligible)}`}
            value={currentEligible}
            onChange={(v) => pushUrl({ eligible: v === 'off' ? '0' : null })}
            options={[
              { value: 'on', label: t('eligible.on') },
              { value: 'off', label: t('eligible.off') },
            ]}
          />
          {/* A member scope (`member_id`, from a member's page) has no chip,
              so when it is the only filter the bar's own "Clear filters" is
              absent: offer it here. */}
          {hasAnyFilter && chips.length === 0 ? (
            <Button variant="ghost" icon="x" touchHeight onClick={clearAll}>
              {t('clear')}
            </Button>
          ) : null}
        </FilterBar>
      </AuraProvider>
    </div>
  );
}
