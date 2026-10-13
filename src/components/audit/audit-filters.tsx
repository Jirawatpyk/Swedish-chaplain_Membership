'use client';

/**
 * F9 US2 (T048) — audit-viewer filters (FR-009) with URL-state sync.
 *
 * The URL is the source of truth (bookmarkable). Changing any filter clears
 * the keyset `cursor` so pagination restarts from the newest page. Filtering
 * by event type, acting user, target record, and date range — individually
 * and in combination.
 *
 * Spec 122 US10b (T1011) — on AURA, in the filter pattern (spec 122, 2 Oct
 * 2026; docs/aura-adoption.md § Filters): the FilterBar's own search is the
 * target record (debounced, synced from the URL), Event type a FilterSelect
 * keeping the category groups, the acting user a labelled field in "More
 * filters" (AURA has no compact free-text filter besides the search), and
 * From–To one FilterDateRange. Every applied value is a removable chip that
 * brings the bar's own "Clear filters", and the count sits at the end of the
 * row. The URL contract is unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AuraProvider,
  Button,
  FilterBar,
  FilterDateRange,
  FilterSelect,
  Popover,
  TextField,
  todayIn,
  type DateRangePreset,
  type ISODate,
} from '@jirawatpyk/aura-react';
import { formatLocalisedDate, getDateFormatLocale } from '@/lib/format-date-localised';
import {
  AUDIT_EVENT_CATEGORY_ORDER,
  auditEventCategory,
  resolveEventLabel,
  type AuditEventCategory,
} from '@/lib/audit-event-label';

const DEBOUNCE_MS = 300;
const ALL = 'all';
const DAY_MS = 86_400_000;

// A real calendar day in `YYYY-MM-DD` (a UTC round-trip is exact for that
// shape), so a hand-typed `?from=2026-02-30` never reaches the range control;
// the page still names the bad field.
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymd(v: string): string {
  if (!YMD_RE.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '' : v;
}
/** A calendar day `days` before `iso` (pure calendar arithmetic, UTC-anchored). */
function daysBefore(iso: string, days: number): ISODate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

export interface AuditFiltersProps {
  readonly eventTypeOptions: readonly string[];
  /** The tenant's IANA timezone, for the range's "today" and presets (the page turns ?from/?to into its day bounds). */
  readonly timeZone: string;
  /** Rows on this page, shown and announced at the end of the row. */
  readonly resultCount?: number;
}

export function AuditFilters({ eventTypeOptions, timeZone, resultCount }: AuditFiltersProps): React.JSX.Element {
  const t = useTranslations('admin.audit.filters');
  const tAudit = useTranslations('admin.audit');
  const tEvents = useTranslations('admin.dashboard.activity.events');
  const tEventsFallback = useTranslations('audit.eventType');
  const tGroups = useTranslations('admin.audit.filters.groups');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const grouped = new Map<AuditEventCategory, string[]>();
  for (const et of eventTypeOptions) {
    const cat = auditEventCategory(et);
    (grouped.get(cat) ?? grouped.set(cat, []).get(cat)!).push(et);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) =>
      resolveEventLabel(tEvents, a, tEventsFallback).localeCompare(resolveEventLabel(tEvents, b, tEventsFallback)),
    );
  }

  const currentEventType = searchParams.get('eventType') ?? ALL;
  const currentActor = searchParams.get('actorUserId') ?? '';
  const currentTarget = searchParams.get('targetRef') ?? '';
  const from = ymd(searchParams.get('from') ?? '');
  const to = ymd(searchParams.get('to') ?? '');

  const pushUrl = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      }
      params.delete('cursor');
      const query = params.toString();
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      });
    },
    [searchParams, router, pathname],
  );

  // Bumped to remount the FilterBar: its unmount drops a search still waiting
  // on the debounce, and the draft restarts from the URL.
  const [searchResetKey, setSearchResetKey] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  // A chip × or Clear unmounts itself; focus moves to Event type, which is
  // always there, so it never drops to <body>.
  const focusEventType = () => barRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
  useEffect(() => {
    if (searchResetKey > 0) focusEventType();
  }, [searchResetKey]);
  const resetSearch = () => setSearchResetKey((k) => k + 1);

  // Calendar days (UTC-anchored ISO dates), so no timezone shifts them.
  const day = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const dayRange = (a: string, b: string) =>
    new Intl.DateTimeFormat(getDateFormatLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).formatRange(
      new Date(`${a}T00:00:00Z`),
      new Date(`${b}T00:00:00Z`),
    );
  const chip = (label: string, value: string) => t('chip', { label, value });
  const chips: { readonly id: string; readonly label: string; readonly clear: () => void }[] = [];
  if (currentEventType !== ALL) {
    chips.push({
      id: 'eventType',
      label: chip(t('eventType'), resolveEventLabel(tEvents, currentEventType, tEventsFallback)),
      clear: () => pushUrl({ eventType: null }),
    });
  }
  if (currentTarget.trim() !== '') {
    chips.push({
      id: 'targetRef',
      label: chip(t('target'), currentTarget.trim()),
      clear: () => {
        resetSearch();
        pushUrl({ targetRef: null });
      },
    });
  }
  if (currentActor.trim() !== '') {
    chips.push({
      id: 'actorUserId',
      label: chip(t('actor'), currentActor.trim()),
      clear: () => pushUrl({ actorUserId: null }),
    });
  }
  if (from || to) {
    const value = from && to ? dayRange(from, to) : from ? t('dateFrom', { from: day(from) }) : t('dateTo', { to: day(to) });
    chips.push({ id: 'dates', label: chip(t('date'), value), clear: () => pushUrl({ from: null, to: null }) });
  }
  const activeFilters = chips.map((c) => ({
    id: c.id,
    label: c.label,
    onRemove: () => {
      c.clear();
      if (c.id !== 'targetRef') focusEventType();
    },
  }));

  const clearAll = () => {
    resetSearch();
    pushUrl({ eventType: null, actorUserId: null, targetRef: null, from: null, to: null });
  };

  // The presets count back from today in the tenant's timezone, today
  // included; "This month" runs from its first day to today.
  const today = todayIn(timeZone);
  const presets: DateRangePreset[] = [
    { label: t('presets.last7'), range: { start: daysBefore(today, 6), end: today } },
    { label: t('presets.last30'), range: { start: daysBefore(today, 29), end: today } },
    { label: t('presets.thisMonth'), range: { start: `${today.slice(0, 8)}01`, end: today } },
  ];

  // The bar's own "Clear filters" and chip × labels, in this page's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: t('clear'),
      remove: (label: string) => t('removeChip', { label }),
    }),
    [t],
  );

  const moreLabel = currentActor.trim() !== '' ? `${t('moreFilters')} (1)` : t('moreFilters');

  return (
    <AuraProvider strings={barStrings}>
      <FilterBar
        key={searchResetKey}
        ref={barRef}
        label={t('legend')}
        searchGrow
        search={currentTarget}
        // Untrimmed on purpose: the FilterBar compares the URL back against
        // what it sent, so a trimmed "abc " would rewrite the box mid-typing.
        // The page trims `targetRef` server-side.
        onSearchChange={(v) => pushUrl({ targetRef: v || null })}
        searchLabel={t('target')}
        searchPlaceholder={t('target')}
        filters={activeFilters}
        {...(activeFilters.length > 0 ? { onClearAll: clearAll } : {})}
        {...(resultCount !== undefined ? { resultCount: tAudit('resultCount', { count: resultCount }) } : {})}
      >
        <FilterSelect
          label={t('eventType')}
          value={currentEventType}
          onChange={(v) => pushUrl({ eventType: v === ALL ? null : v })}
        >
          <option value={ALL}>{t('eventTypeAll')}</option>
          {AUDIT_EVENT_CATEGORY_ORDER.filter((cat) => grouped.has(cat)).map((cat) => (
            <optgroup key={cat} label={tGroups(cat)}>
              {grouped.get(cat)!.map((et) => (
                <option key={et} value={et}>
                  {resolveEventLabel(tEvents, et, tEventsFallback)}
                </option>
              ))}
            </optgroup>
          ))}
        </FilterSelect>
        <FilterDateRange
          label={t('date')}
          timeZone={timeZone}
          presets={presets}
          value={{ start: from || null, end: to || null }}
          // Runs on a complete range, a preset or "Any time" — never on a lone
          // start day — so the URL only ever gets a whole range.
          onChange={(r) => pushUrl({ from: r.start, to: r.end })}
        />
        <Popover
          title={t('moreFilters')}
          placement="bottom-end"
          width={320}
          trigger={
            <Button variant="secondary" size="sm" icon="filter">
              {moreLabel}
            </Button>
          }
        >
          {/* Remounts when the URL's actor changes (a chip ×, Clear), which drops a pending write. */}
          <ActorField
            key={`actor-${currentActor}`}
            label={t('actor')}
            initial={currentActor}
            onCommit={(v) => pushUrl({ actorUserId: v || null })}
          />
        </Popover>
      </FilterBar>
    </AuraProvider>
  );
}

/** The acting-user field: commits the trimmed value after the debounce; unmounting drops a pending commit. */
function ActorField({
  label,
  initial,
  onCommit,
}: {
  readonly label: string;
  readonly initial: string;
  readonly onCommit: (value: string) => void;
}): React.JSX.Element {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <TextField
      label={label}
      defaultValue={initial}
      autoComplete="off"
      onChange={(e) => {
        const value = e.target.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onCommit(value.trim()), DEBOUNCE_MS);
      }}
    />
  );
}
