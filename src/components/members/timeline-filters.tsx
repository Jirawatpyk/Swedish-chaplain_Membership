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
 * disabled until something is filtered. On phones the filters fold into
 * AURA's "Filters" sheet, as on every list (spec 122, 2026-10-15). Shared with
 * the staff member timeline.
 */
import { useCallback, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, DatePicker, FilterBar, Select, type ISODate } from '@jirawatpyk/aura-react';
import { cn } from '@/lib/utils';
import { filterSheetDoneButton } from '@/lib/filter-sheet-focus';
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

  // Four equal filter columns with Clear at the end, as the boards draw them
  // (AURA `controlsLayout="fill"`, #92). Below 640px they move into AURA's
  // Filters sheet, stacked at full width; the button counts the set filters
  // and, with no search beside it, fills the row (AURA 5.43, #148).
  return (
    <FilterBar
      touchHeight
      collapseBelow="sm"
      label={t('title')}
      controlsLayout="fill"
      filterCount={[currentSource !== ALL, currentActor !== ALL, Boolean(currentFrom), Boolean(currentTo)].filter(Boolean).length}
    >
      <Select
        name="source"
        label={t('source')}
        value={currentSource}
        onChange={(e) => pushUrl({ source: e.target.value === ALL ? null : e.target.value })}
        options={[
          { value: ALL, label: t('all') },
          ...TIMELINE_SOURCES.map((s) => ({ value: s, label: tSource(s as TimelineSource) })),
        ]}
      />
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
      {/* From 640px always there, disabled until something is filtered; on a
          phone (in the Filters sheet) only when it can act. */}
      <Button
        type="button"
        variant="secondary"
        className={cn('self-end sm:flex-none', !hasAnyFilter && 'max-sm:hidden')}
        disabled={!hasAnyFilter}
        onClick={() => {
          // It hides once nothing is filtered; in the sheet, focus goes to Done.
          const done = filterSheetDoneButton();
          pushUrl({ source: null, actorKind: null, from: null, to: null });
          if (done) queueMicrotask(() => done.focus());
        }}
      >
        {t('clear')}
      </Button>
    </FilterBar>
  );
}
