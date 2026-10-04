'use client';

/**
 * G-3 — Filter bar for `/admin/credit-notes` directory.
 *
 * Syncs two URL search params (`?q=` for the document-number substring,
 * `?fy=` for the fiscal year) into the current path; any change resets the
 * page and keeps the scroll (`router.push(…, { scroll: false })`).
 *
 * Spec 122 US8c (T844) — the filter pattern (docs/aura-adoption.md § Filters)
 * on AURA's FilterBar: its own debounced search, the fiscal year as a compact
 * `FilterSelect`, the count at the end of the row, and each applied filter as
 * a removable chip that brings the bar's own "Clear filters". The URL
 * contract is unchanged: the page clamps `fy` to 2020–2100.
 */
import { useCallback, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FilterBar, FilterSelect } from '@jirawatpyk/aura-react';

/** The page accepts 2020–2100; offer next year back to 2020, newest first. */
function fiscalYearOptions(allLabel: string) {
  const newest = new Date().getFullYear() + 1;
  const years = Array.from({ length: newest - 2020 + 1 }, (_, i) => String(newest - i));
  return [{ value: '', label: allLabel }, ...years.map((y) => ({ value: y, label: y }))];
}

export function CreditNoteFilters({ resultCount }: { readonly resultCount?: number } = {}) {
  const t = useTranslations('admin.creditNotes.list.filters');
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  // Bumped by a clear to remount the FilterBar, so a search still waiting on
  // its debounce is dropped instead of landing afterwards.
  const [searchResetKey, setSearchResetKey] = useState(0);

  const currentQ = params.get('q') ?? '';
  const currentFy = params.get('fy') ?? '';

  const pushFilters = useCallback(
    (patch: { readonly q?: string; readonly fy?: string }) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value.trim()) next.set(key, value.trim());
        else next.delete(key);
      }
      // Any filter change resets paging — paged offsets from the
      // previous filter window don't map to the new result set.
      next.delete('page');
      const qs = next.toString();
      startTransition(() => {
        // Same-page filter → preserve scroll (canonical rule comment:
        // renewals `urgency-bucket-tabs.tsx` handleChange).
        router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [params, pathname, router],
  );

  const clearAll = () => {
    setSearchResetKey((k) => k + 1);
    pushFilters({ q: '', fy: '' });
  };

  const chips = [
    ...(currentQ.trim()
      ? [
          {
            id: 'q',
            label: t('chipSearch', { q: currentQ.trim() }),
            onRemove: () => {
              setSearchResetKey((k) => k + 1);
              pushFilters({ q: '' });
            },
          },
        ]
      : []),
    ...(currentFy
      ? [
          {
            id: 'fy',
            label: t('chip', { label: t('fiscalYear'), value: currentFy }),
            onRemove: () => pushFilters({ fy: '' }),
          },
        ]
      : []),
  ];

  return (
    <FilterBar
      key={searchResetKey}
      label={t('groupLabel')}
      searchGrow
      search={currentQ}
      onSearchChange={(v) => pushFilters({ q: v })}
      searchLabel={t('search')}
      searchPlaceholder={t('search')}
      filters={chips}
      {...(chips.length > 0 ? { onClearAll: clearAll } : {})}
      {...(resultCount !== undefined ? { resultCount } : {})}
    >
      <FilterSelect
        label={t('fiscalYear')}
        allLabel={t('allShort')}
        value={currentFy}
        onChange={(v) => pushFilters({ fy: v })}
        options={fiscalYearOptions(t('allFiscalYears'))}
      />
    </FilterBar>
  );
}
