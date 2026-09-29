'use client';

/**
 * F9 US3 (T058) — unified-timeline filters (FR-015) with URL-state sync.
 *
 * Mirrors `<AuditFilters />`: the URL is the source of truth (bookmarkable),
 * the `<Select>`s commit on change, and the date inputs commit immediately.
 * Changing any filter clears the keyset `cursor` so pagination restarts from
 * the newest page. Filters: source type, actor kind (staff/member/system),
 * and a from/to date range — individually and in combination.
 *
 * Spec 122 US3 (`Portal-timeline`): AURA FilterBar (the named region), AURA
 * Selects with visible labels and AURA DatePickers (typed or picked; the
 * provider shows Buddhist-era years in Thai — display only, the URL keeps
 * ISO dates), in four equal columns with Clear at the end — always there,
 * disabled until something is filtered. On phones only Source shows, with a
 * "More filters" toggle for the rest. Shared with the staff member timeline.
 */
import { useCallback, useId, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { SlidersHorizontalIcon } from 'lucide-react';
import { Button, DatePicker, FilterBar, Select, type ISODate } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';
import {
  TIMELINE_SOURCES,
  TIMELINE_ACTOR_KINDS,
  type TimelineSource,
  type TimelineActorKind,
} from '@/lib/timeline-shared';

const ALL = 'all';

export function TimelineFilters(): React.JSX.Element {
  const t = useTranslations('timeline.filters');
  const tSource = useTranslations('timeline.source');
  const tActor = useTranslations('timeline.actorKind');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const currentSource = searchParams.get('source') ?? ALL;
  const currentActor = searchParams.get('actorKind') ?? ALL;
  const currentFrom = searchParams.get('from') ?? '';
  const currentTo = searchParams.get('to') ?? '';
  // Phones (the Portal-timeline-mobile board): Source, then "More filters"
  // opens Actor and the dates — open from the start when one of them is set.
  const [moreOpen, setMoreOpen] = useState(
    currentActor !== ALL || Boolean(currentFrom) || Boolean(currentTo),
  );
  const moreId = useId();

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // A filter change invalidates the keyset cursor — a stale cursor would
      // page into the OLD result set and silently drop matching rows.
      params.delete('cursor');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  const hasAnyFilter =
    currentSource !== ALL ||
    currentActor !== ALL ||
    Boolean(currentFrom) ||
    Boolean(currentTo);

  // Four equal filter columns with Clear at the end, as the boards draw them:
  // a stand-in until AURA #92 (FilterBar controls sharing the row evenly).
  return (
    <FilterBar
      label={t('title')}
      className="[&_.aura-filterbar\_\_controls]:w-full [&_.aura-filterbar\_\_controls]:items-end sm:[&_.aura-filterbar\_\_controls]:grid sm:[&_.aura-filterbar\_\_controls]:grid-cols-[repeat(4,minmax(0,1fr))_auto] sm:[&_.aura-filterbar\_\_controls]:gap-3"
    >
      <Select
        name="source"
        label={t('source')}
        className="max-sm:min-w-0 max-sm:flex-1"
        value={currentSource}
        onChange={(e) => pushUrl({ source: e.target.value === ALL ? null : e.target.value })}
        options={[
          { value: ALL, label: t('all') },
          ...TIMELINE_SOURCES.map((s) => ({ value: s, label: tSource(s as TimelineSource) })),
        ]}
      />
      <Button
        type="button"
        variant="secondary"
        className="sm:hidden"
        icon={<SlidersHorizontalIcon aria-hidden />}
        aria-expanded={moreOpen}
        aria-controls={moreId}
        onClick={() => setMoreOpen((open) => !open)}
      >
        {t('moreFilters')}
      </Button>
      <div id={moreId} className={cn('flex w-full flex-col gap-3 sm:contents', !moreOpen && 'max-sm:hidden')}>
        <Select
          name="actorKind"
          label={t('actor')}
          value={currentActor}
          onChange={(e) => pushUrl({ actorKind: e.target.value === ALL ? null : e.target.value })}
          options={[
            { value: ALL, label: t('all') },
            ...TIMELINE_ACTOR_KINDS.map((k) => ({ value: k, label: tActor(k as TimelineActorKind) })),
          ]}
        />
        <DatePicker
          name="from"
          label={t('from')}
          timeZone="Asia/Bangkok"
          value={(currentFrom || null) as ISODate | null}
          onChange={(iso) => pushUrl({ from: iso })}
        />
        <DatePicker
          name="to"
          label={t('to')}
          timeZone="Asia/Bangkok"
          value={(currentTo || null) as ISODate | null}
          onChange={(iso) => pushUrl({ to: iso })}
        />
      </div>

      {/* From 640px always there, disabled until something is filtered; on a
          phone only when it can act, on its own row after the filters. */}
      <Button
        type="button"
        variant="secondary"
        className={cn('max-sm:order-last max-sm:w-full', !hasAnyFilter && 'max-sm:hidden')}
        disabled={!hasAnyFilter}
        onClick={() => pushUrl({ source: null, actorKind: null, from: null, to: null })}
      >
        {t('clear')}
      </Button>
    </FilterBar>
  );
}
