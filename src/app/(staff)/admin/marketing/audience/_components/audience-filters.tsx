'use client';

/**
 * 108 PR-D (FR-035) — Marketing audience filter bar. URL search params are
 * the single source of truth (shareable, back/forward-safe, and what the
 * server parses through `parseMarketingAudienceParams`); every change
 * resets `page`. Same shape as the members directory filters.
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

export function AudienceFilters() {
  const t = useTranslations('admin.marketing.audience.filters');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentQ = searchParams.get('q') ?? '';
  const currentKind = searchParams.get('kind') ?? 'all';
  const currentState = searchParams.get('state') ?? 'all';
  const eligibleRaw = searchParams.get('eligible');
  const currentEligible = eligibleRaw === '0' || eligibleRaw === 'false' ? 'off' : 'on';
  const [searchValue, setSearchValue] = useState(currentQ);

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
    setSearchValue('');
    pushUrl({ q: null, kind: null, state: null, eligible: null, member_id: null });
  };

  return (
    <FilterBar>
      <div className="relative min-w-0 sm:flex-1">
        <SearchIcon
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchLabel')}
          autoComplete="off"
          className="pl-9"
        />
      </div>

      <Select value={currentKind} onValueChange={(v) => pushUrl({ kind: v === 'all' ? null : v })}>
        <SelectTrigger className="sm:w-44" aria-label={t('kindLabel')}>
          <TranslatedSelectValue
            placeholder={t('kindLabel')}
            translate={(v) => t(`kind.${(v || 'all') as 'all' | 'primary' | 'secondary'}`)}
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
        <SelectTrigger className="sm:w-48" aria-label={t('stateLabel')}>
          <TranslatedSelectValue
            placeholder={t('stateLabel')}
            translate={(v) =>
              t(`state.${(v || 'all') as 'all' | (typeof MARKETING_AUDIENCE_STATE_PARAMS)[number]}`)
            }
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
        <SelectTrigger className="sm:w-52" aria-label={t('eligibleLabel')}>
          <TranslatedSelectValue
            placeholder={t('eligibleLabel')}
            translate={(v) => t(`eligible.${(v || 'on') as 'on' | 'off'}`)}
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
