'use client';

/**
 * Queue filters — URL-state-driven client component (F7 UX hardening).
 *
 * Replaces the prior server-rendered `<form method="GET">` whose
 * `defaultChecked` / `defaultValue` attributes never re-synced after
 * client-side navigation (D1). Mirrors the F3 `directory-filters.tsx`
 * pattern: URL is the source of truth, controlled inputs derive their
 * state from `useSearchParams()`, and each change triggers
 * `router.replace()` in a `useTransition` so the UI stays responsive.
 *
 * Default-view semantics preserved (FR-010): with no URL params, the
 * server defaults status filter to `['submitted']`. The `status_all=1`
 * sentinel param distinguishes an EXPLICIT "show all statuses" choice
 * (user unchecked everything) from a pristine first visit.
 *
 * Findings closed by this file: D1, D2, D3 (filter buttons), A1, A2,
 * A3, H3 (see specs/010-email-broadcast review report).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { CalendarClockIcon, InboxIcon } from 'lucide-react';
import { Button, FilterBar, FilterSelect, Tag, TextField } from '@jirawatpyk/aura-react';
// Import directly from the Domain value-object file (NOT the module
// barrel) — the barrel re-exports infrastructure adapters that pull in
// server-only Next.js APIs (`revalidateTag` via the F5 payments repo
// chain). Client components must stay free of those imports.
import {
  APPROVAL_ROUND_ONLY_STATUSES,
  APPROVAL_ROUND_STATUSES,
  OFFERED_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { MARKETING_TURN_STATUSES } from '@/modules/broadcasts/domain/stage/whose-turn';

const DEBOUNCE_MS = 300;

// Default-view filter — mirrors `page.tsx` `statusRaw` resolution so
// the visual checkbox state matches what the server actually filters
// by on a fresh visit (URL has no status params yet). Module-scope
// constant so memo deps stay stable across renders.
const DEFAULT_STATUS: ReadonlyArray<BroadcastStatus> = ['submitted'];

// WS-G: the status chip strip is split into two visually-grouped
// clusters so admins can scan "still needs attention" separately from
// "already resolved" instead of parsing a flat 10-chip row. TERMINAL
// is DERIVED by filtering BROADCAST_STATUSES against IN_REVIEW (not
// hand-listed) so a newly-added status can't silently vanish from
// both groups.
//
// 108 Phase 9 — retired statuses are subtracted from the same derivation
// rather than hand-removed, so that property survives: a status is offered
// unless it is in-review OR retired, and both lists are named. Retired rows
// remain visible under the explicit show-all view and still render their
// badge; only the chip that could return nothing is withheld.
//
// F119 T116 — the four IN-PROGRESS approval-round stages join "In review":
// each is waiting on somebody (marketing, or the member), so filing them under
// "Closed" — where the derivation below would otherwise put them — would hide
// live work among finished work. The fifth new status,
// `expired_no_member_response`, is a closed outcome (in
// `TERMINAL_BROADCAST_STATUSES`, nobody's turn) and derives into "Closed" on
// purpose: listing it here would offer marketing a row nobody can act on
// (/speckit.analyze H4).
const IN_REVIEW_STATUSES: ReadonlyArray<BroadcastStatus> = [
  'submitted',
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
  'approved',
  'sending',
  'draft',
];
// R2-7 — the retired subtraction now lives in the VO as
// `OFFERED_BROADCAST_STATUSES`, so the queue's loading skeleton reserves the
// same number of chips this renders. Filtering it again here would put the rule
// in two places, which is how the skeleton came to reserve 10 for a strip of 8.
const TERMINAL_STATUSES: ReadonlyArray<BroadcastStatus> =
  OFFERED_BROADCAST_STATUSES.filter((s) => !IN_REVIEW_STATUSES.includes(s));

// F119 T116 / T151 — `APPROVAL_ROUND_ONLY_STATUSES` (the five stages whose chip
// follows R18's "flag ON or rows exist") lives in the VO file beside
// `OFFERED_BROADCAST_STATUSES`, so the loading skeleton sizes from it too
// (UX review M2).

/** F119 T119 — the Upcoming sends preset's URL tokens (FR-028). */
const UPCOMING_SORT = 'scheduled_for';
const UPCOMING_FROM = 'now';

/**
 * #400 item 8 — the "Waiting on marketing" preset: the stage filter that IS
 * `MARKETING_TURN_STATUSES`, order-insensitive. Plain `status` params, the
 * URL the staff nav's Broadcasts link and the staff home's card open
 * (`MARKETING_TURN_QUEUE_HREF`), so the page needs no parsing of its own.
 */
function isMarketingTurnView(statuses: ReadonlyArray<BroadcastStatus>): boolean {
  const selected = new Set(statuses);
  return selected.size === MARKETING_TURN_STATUSES.length && MARKETING_TURN_STATUSES.every((s) => selected.has(s));
}

export interface QueueFiltersProps {
  readonly memberOptions: ReadonlyArray<{
    readonly memberId: string;
    readonly displayName: string;
  }>;
  /**
   * F119 T116 (FR-025) — rows per status for the tenant, shown on each chip.
   * `null` when the read failed: the chips render without numbers and every
   * stage is offered (see `APPROVAL_ROUND_ONLY_STATUSES`).
   */
  readonly stageCounts: Readonly<Record<BroadcastStatus, number>> | null;
  /** F119 T116 — `FEATURE_EBLAST_MEMBER_APPROVAL`, read on the server (`readEblastStageChips`). */
  readonly approvalRoundEnabled: boolean;
}

export function QueueFilters({
  memberOptions,
  stageCounts,
  approvalRoundEnabled,
}: QueueFiltersProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.queue.filters');
  const tStatus = useTranslations('admin.broadcasts.queue.status');
  const tStatusGroup = useTranslations('admin.broadcasts.queue.statusGroup');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // UX review LOW — set just before a navigation that will unmount the
  // focused control (a chip offered only because the URL named it; Reset once
  // nothing is left to reset). See the effect below `isOffered`.
  const stageFieldsetRef = useRef<HTMLFieldSetElement>(null);
  const restoreFocusRef = useRef(false);

  const urlStatus = searchParams.getAll('status') as ReadonlyArray<BroadcastStatus>;
  const currentStatusAll = searchParams.get('status_all') === '1';
  const currentSort = searchParams.get('sort');
  const currentFrom = searchParams.get('from');
  const upcomingActive =
    currentSort === UPCOMING_SORT && currentFrom === UPCOMING_FROM;
  // Explicit params only: the no-param default (`submitted`) is never the preset.
  const marketingActive = !currentStatusAll && !upcomingActive && isMarketingTurnView(urlStatus);
  // #400 U2 — the preset is offered by the nav badge's R18 rule: the flag is
  // on, or a row sits in an approval-round stage (unknown counts offer it,
  // like every chip). With the round dark it would be `submitted` plus three
  // stages that cannot hold rows. A preset that arrived by URL keeps its
  // toggle, pressed, so it can still be turned off (the chips' own rule).
  const approvalRoundVisible =
    approvalRoundEnabled || stageCounts === null || APPROVAL_ROUND_STATUSES.some((s) => stageCounts[s] > 0);
  const marketingPresetOffered = marketingActive || approvalRoundVisible;

  // VISUAL set — what the user sees ticked. When `status_all` sentinel
  // is active, every checkbox stays UNCHECKED so the user has an honest
  // visual of "no chip selected → showing everything". Otherwise the
  // explicit URL > default fallback chain drives visual state.
  //
  // Separated from the FILTER set below so users can fully clear the
  // chip strip without the UI snapping back to "all 8 ticked" — which
  // earlier iterations did and was confusing (2026-05-18 user report).
  const visualStatus: ReadonlyArray<BroadcastStatus> = currentStatusAll
    ? []
    : urlStatus.length > 0
      ? urlStatus
      : DEFAULT_STATUS;

  // FILTER set — what toggle arithmetic builds on (so clicking adds /
  // removes against the actual effective filter, not a stale URL view).
  // In sentinel mode it's []; click-to-check then promotes to explicit.
  // Memoised so `toggleStatus` and `hasAnyFilter` keep stable
  // dependency identities (react-hooks/exhaustive-deps).
  const currentStatus = useMemo<ReadonlyArray<BroadcastStatus>>(
    () =>
      currentStatusAll
        ? []
        : urlStatus.length > 0
          ? urlStatus
          : DEFAULT_STATUS,
    [currentStatusAll, urlStatus],
  );
  const currentMemberId = searchParams.get('memberId') ?? '';
  const currentFromDate = searchParams.get('fromDate') ?? '';
  const currentToDate = searchParams.get('toDate') ?? '';
  // Spec 122 US12b — the date fields keep their typed value with the page
  // (AURA moves the bar's controls into the phone "Filters" sheet and back, so
  // an uncontrolled field would reset). Each re-syncs when the URL changes
  // (navigation, Reset), with the render-time "adjust state when a prop
  // changes" pattern; typing still commits to the URL after DEBOUNCE_MS.
  const [fromInput, setFromInput] = useState(currentFromDate);
  const [toInput, setToInput] = useState(currentToDate);
  const [syncedFrom, setSyncedFrom] = useState(currentFromDate);
  const [syncedTo, setSyncedTo] = useState(currentToDate);
  if (currentFromDate !== syncedFrom) {
    setSyncedFrom(currentFromDate);
    setFromInput(currentFromDate);
  }
  if (currentToDate !== syncedTo) {
    setSyncedTo(currentToDate);
    setToInput(currentToDate);
  }
  // FR-030 — the chip counts are per stage for the WHOLE tenant (the FR-025
  // backlog; R18 offers a chip by them), so they do not follow a member filter,
  // a date range or the Upcoming bound. With one of those on, the Stage group
  // says so — on screen and as its accessible description — rather than let
  // "70 E-Blasts" sit beside a list of five. The page's announced total falls
  // back to the rows shown for the same reason (`queueViewNarrowed`).
  const countsNoteId = useId();
  const countsCoverMoreThanView =
    stageCounts !== null &&
    (currentMemberId !== '' || currentFromDate !== '' || currentToDate !== '' || currentFrom === UPCOMING_FROM);

  /**
   * Build a fresh URLSearchParams from a patch object, preserving any
   * unrelated params (e.g. `cursor`) and clearing pagination state on
   * filter change.
   */
  const pushUrl = useCallback(
    (patch: {
      status?: ReadonlyArray<BroadcastStatus> | null;
      statusAll?: boolean | null;
      memberId?: string | null;
      fromDate?: string | null;
      toDate?: string | null;
      upcoming?: boolean;
    }) => {
      const params = new URLSearchParams(searchParams.toString());
      if ('status' in patch) {
        params.delete('status');
        if (patch.status && patch.status.length > 0) {
          for (const s of patch.status) params.append('status', s);
        }
        // F119 T119 — a status change leaves the Upcoming sends preset: its
        // `from=now` bound would otherwise silently hide every row without a
        // future send time from the stages just ticked.
        params.delete('sort');
        params.delete('from');
      }
      if (patch.upcoming === true) {
        params.set('sort', UPCOMING_SORT);
        params.set('from', UPCOMING_FROM);
      }
      if ('statusAll' in patch) {
        if (patch.statusAll) params.set('status_all', '1');
        else params.delete('status_all');
      }
      if ('memberId' in patch) {
        if (patch.memberId) params.set('memberId', patch.memberId);
        else params.delete('memberId');
      }
      if ('fromDate' in patch) {
        if (patch.fromDate) params.set('fromDate', patch.fromDate);
        else params.delete('fromDate');
      }
      if ('toDate' in patch) {
        if (patch.toDate) params.set('toDate', patch.toDate);
        else params.delete('toDate');
      }
      // Filter change always resets pagination cursor.
      params.delete('cursor');
      const query = params.toString();
      startTransition(() => {
        // Same-page filter → preserve scroll (canonical rule comment:
        // renewals `urgency-bucket-tabs.tsx` handleChange).
        router.replace(query ? `${pathname}?${query}` : pathname, {
          scroll: false,
        });
      });
    },
    [searchParams, router, pathname],
  );

  /**
   * Toggle a status checkbox. When the user UNCHECKS the last
   * remaining status, write the `status_all=1` sentinel so the server
   * doesn't fall back to the default `['submitted']` filter — this is
   * the user's explicit "show every status" intent (D1 root cause).
   */
  const toggleStatus = useCallback(
    (status: BroadcastStatus, checked: boolean) => {
      // Unchecking a chip that is on screen only because the URL names it
      // (R18: round off, no rows) unmounts the control under the user.
      if (
        !checked &&
        APPROVAL_ROUND_ONLY_STATUSES.has(status) &&
        !approvalRoundEnabled &&
        stageCounts !== null &&
        stageCounts[status] === 0
      ) {
        restoreFocusRef.current = true;
      }
      const next = checked
        ? Array.from(new Set([...currentStatus, status]))
        : currentStatus.filter((s) => s !== status);
      if (next.length === 0) {
        pushUrl({ status: null, statusAll: true });
      } else {
        pushUrl({ status: next, statusAll: null });
      }
    },
    [currentStatus, pushUrl, approvalRoundEnabled, stageCounts],
  );

  const onDateChange = useCallback(
    (key: 'fromDate' | 'toDate', value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        pushUrl({ [key]: value || null } as Parameters<typeof pushUrl>[0]);
      }, DEBOUNCE_MS);
    },
    [pushUrl],
  );

  // "Has any user-applied filter" — true when the URL has any explicit
  // query param. The default-status fallback above does NOT count
  // (no URL param yet → no Clear button to surface).
  const hasAnyFilter = useMemo(
    () =>
      urlStatus.length > 0 ||
      currentStatusAll ||
      Boolean(currentMemberId) ||
      Boolean(currentFromDate) ||
      Boolean(currentToDate) ||
      Boolean(currentSort) ||
      Boolean(currentFrom),
    [
      urlStatus.length,
      currentStatusAll,
      currentMemberId,
      currentFromDate,
      currentToDate,
      currentSort,
      currentFrom,
    ],
  );

  // "Reset" returns the queue to its DEFAULT view (submitted-only) —
  // the admin's primary daily task per FR-010 + GitHub/Linear/Notion
  // convention. Drops every URL param so the server applies the
  // default-submitted fallback. The button label is intentionally
  // "Reset" (not "Clear") so behaviour matches expectation. Users who
  // explicitly want "show every status" do that by unchecking the
  // submitted chip; the `status_all=1` sentinel surfaces from there
  // automatically.
  const clearAll = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Reset unmounts itself once the URL is clean.
    restoreFocusRef.current = true;
    startTransition(() => {
      // Reset is a same-page filter change too — treated consistently with
      // `pushUrl` above (scroll preserved).
      router.replace(pathname, { scroll: false });
    });
  }, [router, pathname]);

  // F119 T119 — the preset is a toggle: on, it is exactly
  // `?status=approved&sort=scheduled_for&from=now` (member and date filters
  // kept — "upcoming sends for this member" is a real question); off, it
  // removes only what it added — `sort`, `from` and `status` — so the stages
  // return to the default view and the member and date filters stay (UX
  // review M3: it used to call Reset and drop those too).
  const toggleUpcoming = useCallback(() => {
    if (upcomingActive) {
      pushUrl({ status: null, statusAll: null });
      return;
    }
    pushUrl({ status: ['approved'], statusAll: null, upcoming: true });
  }, [upcomingActive, pushUrl]);

  // #400 item 8 — the same toggle shape as Upcoming: on, exactly the four
  // marketing-turn stages (a status change drops the Upcoming bound, and the
  // member and date filters stay); off, back to the FR-010 default.
  const toggleMarketing = useCallback(() => {
    // #400 U2 — turning off a preset that is on screen only because the URL
    // named it (the round is not visible) unmounts the toggle under the user;
    // hand focus on, like a URL-only chip (the effect below `isOffered`).
    if (marketingActive && !approvalRoundVisible) restoreFocusRef.current = true;
    pushUrl(marketingActive ? { status: null, statusAll: null } : { status: MARKETING_TURN_STATUSES, statusAll: null });
  }, [marketingActive, approvalRoundVisible, pushUrl]);

  // Visual check uses the separate `visualStatus` set so sentinel-mode
  // (`status_all=1`) renders ALL chips unchecked — matching the user's
  // mental model of "no filter, show everything".
  const isStatusChecked = (s: BroadcastStatus): boolean =>
    visualStatus.includes(s);

  // F119 T116 / T151 — R18, per chip. A stage already in the URL keeps its
  // chip, checked, so a filter that arrived by link can still be cleared.
  const isOffered = (s: BroadcastStatus): boolean =>
    !APPROVAL_ROUND_ONLY_STATUSES.has(s) ||
    approvalRoundEnabled ||
    stageCounts === null ||
    stageCounts[s] > 0 ||
    urlStatus.includes(s);

  // UX review LOW — when the control that had focus unmounted with the URL
  // change it started, focus fell to `<body>` and a keyboard user had to Tab
  // back from the top of the page. Hand it to the first Stage chip — only
  // then, and only if focus really was lost, so a URL change started anywhere
  // else never moves focus.
  useEffect(() => {
    if (!restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    stageFieldsetRef.current
      ?.querySelector<HTMLButtonElement>('button[aria-pressed]')
      ?.focus();
  }, [searchParams]);

  const renderChip = (s: BroadcastStatus): React.ReactElement => {
    const label = tStatus(s);
    const count = stageCounts === null ? null : stageCounts[s];
    const checked = isStatusChecked(s);
    // Spec 122 US12b — an AURA toggle chip (`aria-pressed`), as every list's
    // filter chips; toggling writes the same URL the checkbox did.
    return (
      <Tag
        key={s}
        data-status={s}
        selected={checked}
        touchHeight
        // From `sm` up the whole stage name and its count show
        // (stand-in until AURA #160: a Tag's text is capped at 24ch outside FilterBar's own chips).
        className="max-w-full sm:[&_.aura-tag\_\_text]:max-w-none"
        onClick={() => toggleStatus(s, !checked)}
      >
        {/* SV runs up to +28 %: below `sm` the label truncates inside its chip
            (the full text in AURA's own tip) instead of reflowing the strip at
            320 px; from `sm` up the whole label shows (UX review M4). */}
        <span className="min-w-0 max-w-[14rem] truncate sm:max-w-none">{label}</span>
        {count !== null ? (
          <>
            {' '}
            {/* The number is visual; its words are in the accessible name. */}
            <span aria-hidden="true" className="shrink-0 tabular-nums text-[var(--aura-fg-secondary)]">
              {count}
            </span>
            <span className="sr-only">{t('chipCount', { count })}</span>
          </>
        ) : null}
      </Tag>
    );
  };

  // The phone "Filters (n)" count: the bar has no chips of its own, so it is
  // told how many filters are on (a preset is a stage filter). The default
  // view's stage counts too, so a phone shows the cards are filtered (UX M2).
  const filterCount =
    (visualStatus.length > 0 || currentStatusAll ? 1 : 0) +
    (currentMemberId ? 1 : 0) +
    (currentFromDate ? 1 : 0) +
    (currentToDate ? 1 : 0);

  // Spec 122 US12b — the global filter pattern: an AURA `FilterBar` whose
  // controls fold into a "Filters (n)" sheet below 640 px. Reset (back to the
  // default view, not "show everything") stays in the bar.
  return (
    <FilterBar
      collapseBelow="sm"
      touchHeight
      label={t('formAriaLabel')}
      filterCount={filterCount}
      actions={
        hasAnyFilter ? (
          <Button variant="ghost" size="sm" touchHeight icon="x" onClick={clearAll}>
            {t('reset')}
          </Button>
        ) : undefined
      }
    >
      {/* UX review B1 — `min-w-0` on the fieldset AND on both group rows: a
          fieldset's default `min-inline-size: min-content` and a flex item's
          `min-width: auto` each pin a chip at its min-content width, so the
          chip's truncation never engaged at 320 px. */}
      <fieldset
        ref={stageFieldsetRef}
        className="m-0 flex min-w-0 basis-full flex-col gap-[var(--aura-space-2)] border-0 p-0"
        aria-describedby={countsCoverMoreThanView ? countsNoteId : undefined}
      >
        <legend className="mb-[var(--aura-space-1)] p-0 aura-text-body font-medium">
          {t('statusLabel')}
        </legend>
        <div className="flex flex-wrap gap-[var(--aura-space-3)]">
          <div
            role="group"
            aria-label={tStatusGroup('inReview')}
            className="flex min-w-0 flex-wrap gap-[var(--aura-space-2)]"
          >
            {IN_REVIEW_STATUSES.filter(isOffered).map(renderChip)}
          </div>
          <div
            role="group"
            aria-label={tStatusGroup('terminal')}
            className="flex min-w-0 flex-wrap gap-[var(--aura-space-2)]"
          >
            {TERMINAL_STATUSES.filter(isOffered).map(renderChip)}
          </div>
        </div>
        {countsCoverMoreThanView ? (
          <p id={countsNoteId} className="aura-text-caption text-[var(--aura-fg-secondary)]">
            {t('chipCountsScope')}
          </p>
        ) : null}
      </fieldset>

      <FilterSelect
        label={t('memberLabel')}
        allLabel={t('memberAll')}
        value={currentMemberId}
        onChange={(v) => pushUrl({ memberId: v || null })}
        options={[
          { value: '', label: t('memberAll') },
          ...memberOptions.map((m) => ({ value: m.memberId, label: m.displayName })),
        ]}
      />

      <TextField
        id="filter-from"
        type="date"
        name="fromDate"
        touchHeight
        label={t('fromDate')}
        value={fromInput}
        onChange={(e) => {
          setFromInput(e.target.value);
          onDateChange('fromDate', e.target.value);
        }}
      />

      <TextField
        id="filter-to"
        type="date"
        name="toDate"
        touchHeight
        label={t('toDate')}
        value={toInput}
        onChange={(e) => {
          setToInput(e.target.value);
          onDateChange('toDate', e.target.value);
        }}
      />

      {/* UX review H5 — a pressed preset must look pressed: AURA's selected
          chip, the same as a ticked stage. */}
      <Tag
        selected={upcomingActive}
        touchHeight
        icon={<CalendarClockIcon aria-hidden="true" />}
        onClick={toggleUpcoming}
      >
        {t('upcomingSends')}
      </Tag>

      {marketingPresetOffered && (
        <Tag
          selected={marketingActive}
          touchHeight
          icon={<InboxIcon aria-hidden="true" />}
          onClick={toggleMarketing}
        >
          {t('waitingOnMarketing')}
        </Tag>
      )}
    </FilterBar>
  );
}
