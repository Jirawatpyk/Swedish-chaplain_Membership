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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  AUDIT_EVENT_CATEGORY_ORDER,
  auditEventCategory,
  resolveEventLabel,
  type AuditEventCategory,
} from '@/lib/audit-event-label';

const DEBOUNCE_MS = 300;
const ALL = 'all';

export function AuditFilters({
  eventTypeOptions,
}: {
  readonly eventTypeOptions: readonly string[];
}): React.JSX.Element {
  const t = useTranslations('admin.audit.filters');
  const tEvents = useTranslations('admin.dashboard.activity.events');
  // Fallback catalogue: the timeline's `audit.eventType` namespace (~99 events
  // with EN/TH/SV) covers codes the viewer namespace lacks, so the filter shows
  // localised labels instead of the humanised English form.
  const tEventsFallback = useTranslations('audit.eventType');
  const tGroups = useTranslations('admin.audit.filters.groups');
  const router = useRouter();

  // Group the ~44 event-type codes by coarse category so the picker is
  // navigable (sorted within each group by localised label).
  const grouped = new Map<AuditEventCategory, string[]>();
  for (const et of eventTypeOptions) {
    const cat = auditEventCategory(et);
    (grouped.get(cat) ?? grouped.set(cat, []).get(cat)!).push(et);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) =>
      resolveEventLabel(tEvents, a, tEventsFallback).localeCompare(
        resolveEventLabel(tEvents, b, tEventsFallback),
      ),
    );
  }
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
              v === ALL ? t('eventTypeAll') : resolveEventLabel(tEvents, v, tEventsFallback)
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('eventTypeAll')}</SelectItem>
          {AUDIT_EVENT_CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
            <SelectGroup key={cat}>
              <SelectLabel>{tGroups(cat)}</SelectLabel>
              {grouped.get(cat)!.map((et) => (
                <SelectItem key={et} value={et}>
                  {resolveEventLabel(tEvents, et, tEventsFallback)}
                </SelectItem>
              ))}
            </SelectGroup>
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
        className="sm:flex-1"
      />

      <Input
        key={`target-${currentTarget}`}
        defaultValue={currentTarget}
        onChange={(e) => onTextChange('targetRef')(e.target.value)}
        placeholder={t('target')}
        aria-label={t('target')}
        autoComplete="off"
        className="sm:flex-1"
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
          <XIcon className="size-4" aria-hidden />
          {t('reset')}
        </Button>
      )}
    </FilterBar>
  );
}
