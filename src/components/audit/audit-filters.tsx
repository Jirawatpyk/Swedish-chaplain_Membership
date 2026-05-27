'use client';

/**
 * F9 US2 (T048) — audit-viewer filters (FR-009) with URL-state sync.
 *
 * Mirrors the `<UsersFilters />` / `<DirectoryFilters />` pattern: the URL is
 * the source of truth (bookmarkable), the shadcn `<Select>` commits on change,
 * and the free-text inputs debounce 300 ms. Changing any filter clears the
 * keyset `cursor` so pagination restarts from the newest page. Filtering by
 * event type, acting user, target record, and date range — individually and in
 * combination.
 */
import { useCallback, useRef, useTransition } from 'react';
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
import { resolveEventLabel } from '@/lib/audit-event-label';

const DEBOUNCE_MS = 300;
const ALL = 'all';

export function AuditFilters({
  eventTypeOptions,
}: {
  readonly eventTypeOptions: readonly string[];
}): React.JSX.Element {
  const t = useTranslations('admin.audit.filters');
  const tEvents = useTranslations('admin.dashboard.activity.events');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentEventType = searchParams.get('eventType') ?? ALL;
  const currentActor = searchParams.get('actorUserId') ?? '';
  const currentTarget = searchParams.get('targetRef') ?? '';
  const currentFrom = searchParams.get('from') ?? '';
  const currentTo = searchParams.get('to') ?? '';

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      // Any filter change invalidates the keyset cursor — a stale cursor would
      // page into the OLD result set and silently drop matching rows.
      params.delete('cursor');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, router, pathname],
  );

  const onTextChange = (key: 'actorUserId' | 'targetRef') => (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      pushUrl({ [key]: value.trim() || null });
    }, DEBOUNCE_MS);
  };

  const hasAnyFilter =
    currentEventType !== ALL ||
    Boolean(currentActor) ||
    Boolean(currentTarget) ||
    Boolean(currentFrom) ||
    Boolean(currentTo);

  const clearAll = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    pushUrl({ eventType: null, actorUserId: null, targetRef: null, from: null, to: null });
  };

  return (
    <FilterBar aria-label={t('legend')}>
      <Select
        value={currentEventType}
        onValueChange={(v) => pushUrl({ eventType: v === ALL ? null : v })}
      >
        <SelectTrigger className="sm:w-64" aria-label={t('eventType')}>
          <TranslatedSelectValue
            placeholder={t('eventTypeAll')}
            translate={(v) =>
              v === ALL ? t('eventTypeAll') : resolveEventLabel(tEvents, v)
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('eventTypeAll')}</SelectItem>
          {eventTypeOptions.map((et) => (
            <SelectItem key={et} value={et}>
              {resolveEventLabel(tEvents, et)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        key={`actor-${currentActor}`}
        defaultValue={currentActor}
        onChange={(e) => onTextChange('actorUserId')(e.target.value)}
        placeholder={t('actor')}
        aria-label={t('actor')}
        autoComplete="off"
        className="sm:w-48"
      />

      <Input
        key={`target-${currentTarget}`}
        defaultValue={currentTarget}
        onChange={(e) => onTextChange('targetRef')(e.target.value)}
        placeholder={t('target')}
        aria-label={t('target')}
        autoComplete="off"
        className="sm:w-48"
      />

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
          onClick={clearAll}
          className="whitespace-nowrap"
        >
          <XIcon className="size-4" />
          {t('reset')}
        </Button>
      )}
    </FilterBar>
  );
}
