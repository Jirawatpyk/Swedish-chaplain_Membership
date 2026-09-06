'use client';

/**
 * 108 PR-D (FR-035) — Marketing audience filter bar. URL search params are
 * the single source of truth (shareable, back/forward-safe, and what the
 * server parses through `parseMarketingAudienceParams`); every change
 * resets `page`. Same shape as the members directory filters — including
 * the two lessons that file carries (review cycle 11, H1 / H2):
 *
 *   - the search box is a CONTROLLED input that re-syncs FROM the URL only
 *     when it is not focused (Clear-filters CTA, the pre-flight preset,
 *     browser back/forward) — never mid-type;
 *   - "Clear filters" unmounts itself in the same commit as the navigation,
 *     so focus is moved to the always-present search input FIRST or it
 *     falls back to <body> (a focus-loss class axe never catches).
 *
 * Each select trigger names itself with its label AND its current value so
 * a screen reader hears "Contact role: Secondary only", not just the label
 * (a11y review 7); the triggers size to content (`min-w`) so a long SV/TH
 * value wraps instead of clipping (FR-035c, review M5).
 */
import { useCallback, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SearchIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilterBar } from '@/components/ui/filter-bar';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { MARKETING_AUDIENCE_STATE_PARAMS } from '@/lib/marketing-audience-filter';

const DEBOUNCE_MS = 300;
const KIND_VALUES = ['primary', 'secondary'] as const;
type KindValue = 'all' | (typeof KIND_VALUES)[number];
type StateValue = 'all' | (typeof MARKETING_AUDIENCE_STATE_PARAMS)[number];
type EligibleValue = 'on' | 'off';

export function AudienceFilters() {
  const t = useTranslations('admin.marketing.audience.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentKind = (searchParams.get('kind') ?? 'all') as KindValue;
  const currentState = (searchParams.get('state') ?? 'all') as StateValue;
  const eligibleRaw = searchParams.get('eligible');
  const currentEligible: EligibleValue =
    eligibleRaw === '0' || eligibleRaw === 'false' ? 'off' : 'on';

  // Reconcile FROM the URL only when the input is NOT focused — the React
  // "adjust state when a prop changes" pattern, during render (no effect,
  // no key-remount). See directory-filters.tsx for the long version.
  const [searchValue, setSearchValue] = useState(currentQ);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [syncedQ, setSyncedQ] = useState(currentQ);
  if (currentQ !== syncedQ) {
    setSyncedQ(currentQ);
    if (!isSearchFocused) setSearchValue(currentQ);
  }

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
    setSearchValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ q: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    Boolean(currentQ) ||
    currentKind !== 'all' ||
    currentState !== 'all' ||
    currentEligible === 'off' ||
    searchParams.has('member_id');

  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // The Clear button unmounts in the commit that processes this navigation
    // — hand focus to the search input FIRST.
    searchInputRef.current?.focus();
    setSearchValue('');
    pushUrl({ q: null, kind: null, state: null, eligible: null, member_id: null });
  };

  const kindLabel = (v: KindValue) => t(`kind.${v}`);
  const stateLabel = (v: StateValue) => t(`state.${v}`);
  const eligibleLabel = (v: EligibleValue) => t(`eligible.${v}`);

  return (
    <FilterBar>
      <div className="relative min-w-0 sm:flex-1">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchInputRef}
          type="search"
          enterKeyHint="search"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <Select value={currentKind} onValueChange={(v) => pushUrl({ kind: v === 'all' ? null : v })}>
        <SelectTrigger
          className="sm:min-w-44"
          aria-label={`${t('kindLabel')}: ${kindLabel(currentKind)}`}
        >
          <TranslatedSelectValue
            placeholder={t('kindLabel')}
            translate={(v) => kindLabel((v || 'all') as KindValue)}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('kind.all')}</SelectItem>
          {KIND_VALUES.map((k) => (
            <SelectItem key={k} value={k}>
              {t(`kind.${k}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={currentState} onValueChange={(v) => pushUrl({ state: v === 'all' ? null : v })}>
        <SelectTrigger
          className="sm:min-w-48"
          aria-label={`${t('stateLabel')}: ${stateLabel(currentState)}`}
        >
          <TranslatedSelectValue
            placeholder={t('stateLabel')}
            translate={(v) => stateLabel((v || 'all') as StateValue)}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('state.all')}</SelectItem>
          {MARKETING_AUDIENCE_STATE_PARAMS.map((s) => (
            <SelectItem key={s} value={s}>
              {t(`state.${s}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={currentEligible}
        onValueChange={(v) => pushUrl({ eligible: v === 'off' ? '0' : null })}
      >
        <SelectTrigger
          className="sm:min-w-52"
          aria-label={`${t('eligibleLabel')}: ${eligibleLabel(currentEligible)}`}
        >
          <TranslatedSelectValue
            placeholder={t('eligibleLabel')}
            translate={(v) => eligibleLabel((v || 'on') as EligibleValue)}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="on">{t('eligible.on')}</SelectItem>
          <SelectItem value="off">{t('eligible.off')}</SelectItem>
        </SelectContent>
      </Select>

      {hasAnyFilter && (
        <Button type="button" variant="ghost" size="sm" onClick={clearAll}>
          <XIcon className="size-4" aria-hidden />
          {t('clear')}
        </Button>
      )}
    </FilterBar>
  );
}
