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
 * Spec 122 US3: AURA FilterBar (the named region), AURA Selects (named by
 * aria-label, as before) and labelled AURA date fields; Clear is an AURA
 * ghost button. Shared with the staff member timeline.
 */
import { useCallback, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, FilterBar, Select, TextField } from '@jirawatpyk/aura-react';
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

  return (
    <FilterBar label={t('title')}>
      <Select
        name="source"
        aria-label={t('source')}
        className="sm:w-48"
        value={currentSource}
        onChange={(e) => pushUrl({ source: e.target.value === ALL ? null : e.target.value })}
        options={[
          { value: ALL, label: t('all') },
          ...TIMELINE_SOURCES.map((s) => ({ value: s, label: tSource(s as TimelineSource) })),
        ]}
      />
      <Select
        name="actorKind"
        aria-label={t('actor')}
        className="sm:w-40"
        value={currentActor}
        onChange={(e) => pushUrl({ actorKind: e.target.value === ALL ? null : e.target.value })}
        options={[
          { value: ALL, label: t('all') },
          ...TIMELINE_ACTOR_KINDS.map((k) => ({ value: k, label: tActor(k as TimelineActorKind) })),
        ]}
      />
      <TextField
        type="date"
        label={t('from')}
        className="sm:w-40"
        value={currentFrom}
        onChange={(e) => pushUrl({ from: e.target.value || null })}
      />
      <TextField
        type="date"
        label={t('to')}
        className="sm:w-40"
        value={currentTo}
        onChange={(e) => pushUrl({ to: e.target.value || null })}
      />

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon="x"
          onClick={() => pushUrl({ source: null, actorKind: null, from: null, to: null })}
        >
          {t('clear')}
        </Button>
      )}
    </FilterBar>
  );
}
