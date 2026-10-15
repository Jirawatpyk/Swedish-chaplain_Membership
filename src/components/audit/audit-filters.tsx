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
 *
 * Spec 122 (2026-10-15, AURA #146): below 640px the bar's filters fold into
 * AURA's Filters sheet, and the acting user leaves "More filters" to list
 * there with the others. The sheet remounts the fields it moves, so the
 * acting user's draft and its debounce live here, not in the field.
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
  useBreakpoint,
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
  // Collate in the UI locale: the FilterSelect renders every option on the
  // server, and the runtime default (th-TH on a server, en in a browser)
  // would order them differently on each side and break hydration (R43).
  for (const list of grouped.values()) {
    list.sort((a, b) =>
      resolveEventLabel(tEvents, a, tEventsFallback).localeCompare(
        resolveEventLabel(tEvents, b, tEventsFallback),
        locale,
      ),
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
  // The acting user's draft: commits trimmed after the debounce. Kept here so
  // it survives the field remounting (the Filters sheet, the popover).
  const [actorDraft, setActorDraft] = useState(currentActor);
  // The value waiting on the debounce; null when nothing is pending.
  const [actorPending, setActorPending] = useState<string | null>(null);
  useEffect(() => {
    if (actorPending === null) return;
    const timer = setTimeout(() => {
      setActorPending(null);
      pushUrl({ actorUserId: actorPending.trim() || null });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [actorPending, pushUrl]);
  // The URL moved to another actor (back/forward): show it. Never while the
  // field has focus — a commit landing late would overwrite what is being
  // typed, and its own commit would drop a trailing space.
  const [actorFocused, setActorFocused] = useState(false);
  const [seenActor, setSeenActor] = useState(currentActor);
  if (seenActor !== currentActor) {
    setSeenActor(currentActor);
    if (!actorFocused && actorDraft.trim() !== currentActor) setActorDraft(currentActor);
  }
  const onActorChange = (value: string) => {
    setActorDraft(value);
    setActorPending(value);
  };
  // A chip × or Clear: drop a pending write and empty the field.
  const resetActor = () => {
    setActorPending(null);
    setActorDraft('');
  };

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
      clear: () => {
        resetActor();
        pushUrl({ actorUserId: null });
      },
    });
  }
  // Built from the raw parameters, so a hand-typed bad date (which the range
  // control ignores) still gets a chip and "Clear filters" and the invalid
  // view can be left. A reversed range is shown as its two days, not as one.
  const rawFrom = (searchParams.get('from') ?? '').trim();
  const rawTo = (searchParams.get('to') ?? '').trim();
  if (rawFrom || rawTo) {
    const fromText = from ? day(from) : rawFrom;
    const toText = to ? day(to) : rawTo;
    const value =
      from && to && from <= to
        ? dayRange(from, to)
        : rawFrom && rawTo
          ? `${fromText} – ${toText}`
          : rawFrom
            ? t('dateFrom', { from: fromText })
            : t('dateTo', { to: toText });
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

  // No remount here: the bar's own "Clear filters" already drops its search
  // draft and pending debounce, and a remount would recreate the live count
  // so the new count went unannounced. Focus moves to Event type before the
  // Clear button unmounts itself.
  const clearAll = () => {
    resetActor();
    focusEventType();
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
  // Phones list the acting user in the Filters sheet with the other filters
  // (`lg` on the server, so the server HTML keeps the popover).
  const onPhone = useBreakpoint() === 'base';
  const actorField = (
    <TextField
      label={t('actor')}
      value={actorDraft}
      autoComplete="off"
      onFocus={() => setActorFocused(true)}
      onBlur={() => setActorFocused(false)}
      onChange={(e) => onActorChange(e.target.value)}
    />
  );

  return (
    <AuraProvider strings={barStrings}>
      <FilterBar
        collapseBelow="sm"
        touchHeight
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
        {onPhone ? (
          actorField
        ) : (
          <Popover
            title={t('moreFilters')}
            placement="bottom-end"
            width={320}
            trigger={
              <Button variant="secondary" size="sm" icon="filter" touchHeight>
                {moreLabel}
              </Button>
            }
          >
            {actorField}
          </Popover>
        )}
      </FilterBar>
    </AuraProvider>
  );
}
