'use client';

/**
 * F9 US3 (T058) — unified-timeline filters (FR-015) with URL-state sync.
 *
 * Mirrors `<AuditFilters />`: the URL is the source of truth (bookmarkable),
 * the `<Select>`s commit on change, and the date inputs commit immediately.
 * Changing any filter clears the keyset `cursor` so pagination restarts from
 * the newest page. Filters: source type, actor kind (staff/member/system),
 * and a from/to date range — individually and in combination.
 */
import { useCallback, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { XIcon } from 'lucide-react';
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
    <FilterBar aria-label={t('title')}>
      <Select
        value={currentSource}
        onValueChange={(v) => pushUrl({ source: v === ALL ? null : v })}
      >
        <SelectTrigger className="sm:w-48" aria-label={t('source')}>
          <TranslatedSelectValue
            placeholder={t('all')}
            translate={(v) => (v === ALL ? t('all') : tSource(v as TimelineSource))}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('all')}</SelectItem>
          {TIMELINE_SOURCES.map((s) => (
            <SelectItem key={s} value={s}>
              {tSource(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={currentActor}
        onValueChange={(v) => pushUrl({ actorKind: v === ALL ? null : v })}
      >
        <SelectTrigger className="sm:w-40" aria-label={t('actor')}>
          <TranslatedSelectValue
            placeholder={t('all')}
            translate={(v) => (v === ALL ? t('all') : tActor(v as TimelineActorKind))}
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('all')}</SelectItem>
          {TIMELINE_ACTOR_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {tActor(k)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        type="date"
        value={currentFrom}
        onChange={(e) => pushUrl({ from: e.target.value || null })}
        aria-label={t('from')}
        className="sm:w-40"
      />
      <Input
        type="date"
        value={currentTo}
        onChange={(e) => pushUrl({ to: e.target.value || null })}
        aria-label={t('to')}
        className="sm:w-40"
      />

      {hasAnyFilter && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => pushUrl({ source: null, actorKind: null, from: null, to: null })}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" aria-hidden />
          {t('clear')}
        </Button>
      )}
    </FilterBar>
  );
}
