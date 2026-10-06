/**
 * Spec 122 US9a (T902) — the events list's filter row, on the one filter
 * pattern (docs/aura-adoption.md § Filters; board `Admin-events`): AURA's
 * FilterBar with the search, then three toggle chips, and the result count at
 * its end. It replaces the search form and the link chips; the URL parameters
 * are the same (`q`, `partnerBenefitOnly`, `culturalEventOnly`,
 * `includeArchived`), and any change drops `page` so the list restarts at page 1.
 *
 * - The search filters as you type (AURA writes it after a pause, at once on
 *   Enter or clear). The board's Search button goes, as on every migrated list.
 * - The count keeps today's wording, which names the search ("5 events for
 *   'midsummer'"), and is the bar's polite live region: the page's separate
 *   hidden live region goes.
 * - A toggle chip is not repeated as a removable chip, so while only chips are
 *   on, a ghost "Clear filters" sits beside them (as on Members and Plans).
 *
 * Client component: the row updates the URL in place (`router.replace`, no
 * scroll), which needs client-side navigation.
 */
'use client';

import { useMemo, useRef, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AuraProvider, Button, FilterBar, Tag } from '@jirawatpyk/aura-react';

type ToggleKey = 'partnerBenefitOnly' | 'culturalEventOnly' | 'includeArchived';

export interface EventsListFiltersProps {
  /** The `q` the shown rows were loaded with. */
  readonly search: string;
  readonly partnerBenefitOnly: boolean;
  readonly culturalEventOnly: boolean;
  readonly includeArchived: boolean;
  /** Every event matching the filters, across the pages. */
  readonly resultCount: number;
}

export function EventsListFilters({
  search,
  partnerBenefitOnly,
  culturalEventOnly,
  includeArchived,
  resultCount,
}: EventsListFiltersProps) {
  const t = useTranslations('admin.events.list');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const barRef = useRef<HTMLDivElement>(null);

  function write(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') params.delete(k);
      else params.set(k, v);
    }
    const query = params.toString();
    startTransition(() => {
      // In place, as every list's filters: no history entry per pick, no jump.
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  }

  const toggle = (key: ToggleKey, on: boolean) => write({ [key]: on ? null : '1' });

  // `categoryFilter` has no control in the row (it arrives by link), but it
  // filters the list, so Clear filters offers itself for it and drops it.
  const hasCategory = (searchParams.get('categoryFilter') ?? '').trim() !== '';
  const anyChip = partnerBenefitOnly || culturalEventOnly || includeArchived || hasCategory;

  function clearAll() {
    write({ q: null, partnerBenefitOnly: null, culturalEventOnly: null, includeArchived: null, categoryFilter: null });
    // The pressed control unmounts; the search keeps focus in the row.
    queueMicrotask(() => barRef.current?.querySelector<HTMLElement>('input[type="search"]')?.focus());
  }

  const barStrings = useMemo(() => ({ clearFilters: t('filters.clearAll') }), [t]);

  return (
    // Busy while a filter change loads (the old Search button's spinner).
    <div aria-busy={isPending}>
    <AuraProvider strings={barStrings}>
      <FilterBar
        ref={barRef}
        label={t('filters.groupLabel')}
        searchGrow
        search={search}
        searchLabel={t('searchLabel')}
        searchPlaceholder={t('searchPlaceholder')}
        onSearchChange={(value: string) => write({ q: value.trim() || null })}
        {...(search !== '' ? { onClearAll: clearAll } : {})}
        resultCount={
          search !== ''
            ? t('resultsAnnouncementWithQuery', { count: resultCount, query: search })
            : t('resultsAnnouncement', { count: resultCount })
        }
      >
        <Tag selected={partnerBenefitOnly} touchHeight onClick={() => toggle('partnerBenefitOnly', partnerBenefitOnly)}>
          {t('filters.partnerBenefitOnly')}
        </Tag>
        <Tag selected={culturalEventOnly} touchHeight onClick={() => toggle('culturalEventOnly', culturalEventOnly)}>
          {t('filters.culturalEventOnly')}
        </Tag>
        <Tag selected={includeArchived} touchHeight onClick={() => toggle('includeArchived', includeArchived)}>
          {t('filters.showArchived')}
        </Tag>
        {anyChip && search === '' ? (
          <Button variant="ghost" size="sm" icon="x" touchHeight onClick={clearAll}>
            {t('filters.clearAll')}
          </Button>
        ) : null}
      </FilterBar>
    </AuraProvider>
    </div>
  );
}
