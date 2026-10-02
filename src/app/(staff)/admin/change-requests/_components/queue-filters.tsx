'use client';

/**
 * F114 US4 — the /admin/change-requests filter bar (state · outcome · date range).
 *
 * URL is the source of truth (the page validates `?state=&outcome=&from=&to=`
 * and applies the tenant-day bounds). The filter pattern (spec 122, 2 Oct
 * 2026; docs/aura-adoption.md § Filters): one AURA FilterBar row that filters
 * as you pick — Status, then Outcome right after it only under Decided (the
 * only state that has an outcome), then one "Submitted" `FilterDateRange`
 * whose range writes `from` and the inclusive `to`. A filter change restarts
 * paging (never the cursor) and keeps the scroll position.
 *
 * Every non-default value is a removable chip in the bar — the status
 * (pending is the default view, so it never counts), the outcome, the range,
 * and the member / submitter scoping that the member record's link and the
 * staff email's deep link set — which is also what makes the bar's own
 * "Clear filters" appear; it drops everything, as the page's "clear" always
 * did. The result count sits at the end of the row in AURA's polite live
 * region, updated in place on every pick.
 *
 * Decision (2 Oct 2026): no pre-hydration submit. The bar used to be a real
 * GET `<form>` with hidden inputs so an Enter before hydration sent the same
 * query; `FilterDateRange` has no form field and nothing here is typed, so
 * the bar is plain client UI, like the other filter rows.
 *
 * The range takes the tenant's timezone for "today" and the presets — the
 * same one the page turns ?from/?to into day bounds with.
 */
import { useCallback, useMemo, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  AuraProvider,
  FilterBar,
  FilterDateRange,
  FilterSelect,
  todayIn,
  type DateRangePreset,
  type ISODate,
} from '@jirawatpyk/aura-react';
import { formatLocalisedDate, getDateFormatLocale } from '@/lib/format-date-localised';
// the Domain file, not the module barrel — the barrel re-exports server-only
// use cases (the review client imports the same way)
import {
  CHANGE_REQUEST_OUTCOMES,
  CHANGE_REQUEST_STATES,
  type ChangeRequestOutcome,
  type ChangeRequestState,
} from '@/modules/members/domain/change-request/change-request';

const ANY_OUTCOME = 'any' as const;
const DEFAULT_STATE: ChangeRequestState = 'pending';
const DAY_MS = 86_400_000;
/** Every param the page reads, in the order the queue writes them (never the cursor). */
const PARAM_ORDER = ['state', 'outcome', 'memberId', 'submitter', 'from', 'to'] as const;

function isState(v: string | null): v is ChangeRequestState {
  return v !== null && (CHANGE_REQUEST_STATES as readonly string[]).includes(v);
}
function isOutcome(v: string | null): v is ChangeRequestOutcome {
  return v !== null && (CHANGE_REQUEST_OUTCOMES as readonly string[]).includes(v);
}
// the page's rule (`isYmd`: a REAL calendar day, not only the shape — the
// tenant-day helper throws on `2026-02-30`) without js-joda in the client
// bundle: a UTC round-trip is exact for `YYYY-MM-DD`. A date the page would
// refuse is never shown as a filter (re-review R1).
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function ymd(v: string | null): string {
  if (v === null || !YMD_RE.test(v)) return '';
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? '' : v;
}
/** A calendar day `days` before `iso` (pure calendar arithmetic, UTC-anchored). */
function daysBefore(iso: string, days: number): ISODate {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

export interface ChangeRequestQueueFiltersProps {
  /** The rows the page is showing — the count at the end of the row. */
  readonly resultCount: number;
  /** A next page exists — the count says "the first N". */
  readonly hasMore: boolean;
  /** The tenant's IANA timezone (`env.tenant.timezone`), for the range's "today" and presets. */
  readonly timeZone: string;
  /** `?memberId=`'s company, resolved by the page, for its chip. */
  readonly memberCompany?: string | null;
}

export function ChangeRequestQueueFilters({ resultCount, hasMore, timeZone, memberCompany = null }: ChangeRequestQueueFiltersProps) {
  const tFilters = useTranslations('admin.changeRequests.filters');
  const tReview = useTranslations('admin.changeRequests.review');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  // the URL, read the way the page reads it: a value the page would drop
  // (`?state=bogus`, `2026-02-30`) is no filter, and an outcome counts only
  // under `decided`
  const rawState = params.get('state');
  const state: ChangeRequestState = isState(rawState) ? rawState : DEFAULT_STATE;
  const rawOutcome = params.get('outcome');
  const outcome = state === 'decided' && isOutcome(rawOutcome) ? rawOutcome : ANY_OUTCOME;
  const from = ymd(params.get('from'));
  const to = ymd(params.get('to'));
  const memberId = params.get('memberId');
  const submitter = params.get('submitter');

  const replaceUrl = useCallback(
    (next: URLSearchParams) => {
      // a filter change restarts paging — `write` never carries the cursor
      const qs = next.toString();
      startTransition(() => {
        // same-page filter → keep the scroll position (the renewals
        // `urgency-bucket-tabs.tsx` rule)
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
      });
    },
    [pathname, router],
  );

  /**
   * The current filters with `patch` applied (`null` drops a param), written
   * in the order the queue always wrote them, so a view has one URL.
   */
  const write = (patch: Partial<Record<(typeof PARAM_ORDER)[number], string | null>>) => {
    const next = new URLSearchParams();
    for (const key of PARAM_ORDER) {
      const v = key in patch ? patch[key] : params.get(key);
      if (v) next.set(key, v);
    }
    replaceUrl(next);
  };

  const onStateChange = (v: string) => {
    const nextState = isState(v) ? v : DEFAULT_STATE;
    // the pending default writes no param; leaving `decided` drops its
    // outcome, so a later return never re-applies a choice not made again
    write({
      state: nextState === DEFAULT_STATE ? null : nextState,
      ...(nextState === 'decided' ? {} : { outcome: null }),
    });
  };

  // Calendar days (UTC-anchored ISO dates), so no timezone shifts them. The
  // range reads compactly ("1–10 Sept 2026"): AURA's chips stop at 24ch.
  const day = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const dayRange = (a: string, b: string) =>
    new Intl.DateTimeFormat(getDateFormatLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).formatRange(
      new Date(`${a}T00:00:00Z`),
      new Date(`${b}T00:00:00Z`),
    );
  const chip = (label: string, value: string) => tFilters('chip', { label, value });
  const chips: { readonly id: string; readonly label: string; readonly patch: Parameters<typeof write>[0] }[] = [];
  if (state !== DEFAULT_STATE) {
    chips.push({
      id: 'state',
      label: chip(tFilters('state'), tReview(`state.${state}`)),
      patch: { state: null, outcome: null },
    });
  }
  if (outcome !== ANY_OUTCOME) {
    chips.push({ id: 'outcome', label: chip(tFilters('outcome'), tReview(`outcome.${outcome}`)), patch: { outcome: null } });
  }
  if (from || to) {
    const value =
      from && to
        ? dayRange(from, to)
        : from
          ? tFilters('dateFrom', { from: day(from) })
          : tFilters('dateTo', { to: day(to) });
    chips.push({ id: 'dates', label: chip(tFilters('submitted'), value), patch: { from: null, to: null } });
  }
  if (memberId) {
    chips.push({
      id: 'memberId',
      label: chip(tFilters('member'), memberCompany ?? tFilters('unknownMember')),
      patch: { memberId: null },
    });
  }
  if (submitter) {
    chips.push({ id: 'submitter', label: tFilters('submitterChip'), patch: { submitter: null } });
  }
  const activeFilters = chips.map((c) => ({ id: c.id, label: c.label, onRemove: () => write(c.patch) }));

  // The presets count back from today in the tenant's timezone, today
  // included; "This month" runs from its first day to today.
  const today = todayIn(timeZone);
  const presets: DateRangePreset[] = [
    { label: tFilters('presets.last7'), range: { start: daysBefore(today, 6), end: today } },
    { label: tFilters('presets.last30'), range: { start: daysBefore(today, 29), end: today } },
    { label: tFilters('presets.thisMonth'), range: { start: `${today.slice(0, 8)}01`, end: today } },
  ];

  // The bar's own "Clear filters" and chip × labels, in this page's words.
  const barStrings = useMemo(
    () => ({
      clearFilters: tFilters('clear'),
      remove: (label: string) => tFilters('removeChip', { filter: label }),
    }),
    [tFilters],
  );

  return (
    <div data-testid="queue-filters" aria-busy={pending}>
      <AuraProvider strings={barStrings}>
        <FilterBar
          label={tFilters('label')}
          filters={activeFilters}
          {...(activeFilters.length > 0 ? { onClearAll: () => replaceUrl(new URLSearchParams()) } : {})}
          resultCount={
            <span data-testid="queue-result-count">
              {hasMore ? tFilters('resultCountMore', { count: resultCount }) : tFilters('resultCount', { count: resultCount })}
            </span>
          }
        >
          <FilterSelect
            label={tFilters('state')}
            data-testid="queue-filter-state"
            value={state}
            onChange={onStateChange}
            options={CHANGE_REQUEST_STATES.map((s) => ({ value: s, label: tReview(`state.${s}`) }))}
          />
          {state === 'decided' ? (
            <FilterSelect
              label={tFilters('outcome')}
              allLabel={tFilters('anyShort')}
              data-testid="queue-filter-outcome"
              value={outcome}
              onChange={(v) => write({ outcome: isOutcome(v) ? v : null })}
              options={[
                { value: ANY_OUTCOME, label: tFilters('anyOutcome') },
                ...CHANGE_REQUEST_OUTCOMES.map((o) => ({ value: o, label: tReview(`outcome.${o}`) })),
              ]}
            />
          ) : null}
          <FilterDateRange
            label={tFilters('submitted')}
            timeZone={timeZone}
            presets={presets}
            value={{ start: from || null, end: to || null }}
            // Runs on a complete range, a preset or "Any time" — never on a
            // lone start day — so the URL only ever gets a whole range.
            onChange={(r) => write({ from: r.start, to: r.end })}
          />
        </FilterBar>
      </AuraProvider>
    </div>
  );
}
