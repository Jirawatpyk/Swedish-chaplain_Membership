/**
 * Attendee table (F6 Phase 4 / US2 AS2-AS4).
 *
 * Renders the paginated attendee list for an event detail page and its
 * filter row. Server-side pagination + filter — the row writes URL params
 * and the server component re-renders.
 *
 * Columns:
 * - Attendee  (name + email (copy button) + company stacked)
 * - Match     (MatchStatusBadge — 5 variants)
 * - Ticket    (type + price + payment status)
 * - Quota     (Partner / Cultural / Over-quota / Not counted badges; can be
 * multiple)
 * - Registered (locale-formatted)
 * - Actions   (Relink + Erase PII; admin only)
 *
 * Spec 122 US9a (T904) — on AURA, board `Admin-event-detail` (+ `-mobile`)
 * and the filter pattern (docs/aura-adoption.md § Filters):
 * - `FilterBar`: the search (filters as you type; Enter and clear write at
 *   once), the "Show unmatched only" toggle chip, a compact payment-status
 *   `FilterSelect`, and the count at the row's end — the bar's polite live
 *   region, so the separate hidden one goes. An applied search or status is a
 *   removable chip, which brings the bar's "Clear filters"; with only the
 *   toggle on, a ghost "Clear filters" sits beside it (as on the events list).
 *   The URL parameters (`q`, `unmatchedOnly`, `paymentStatus`) are unchanged;
 *   every write drops `page` and is in place (`router.replace`, no scroll).
 * - AURA `DataTable`, a card per attendee below 640px (name over email, the
 *   match badge beside it, Relink and Erase at the card's foot).
 * - The filtered-empty state is the shared `EmptyState`, keeping "Clear
 *   filters" (toast, then focus back to the search — R3-F5 / R4-U2).
 * - Unchanged: the R3-F1 payment-status URL guard, the erase-trigger
 *   visibility rule (DV-6), the copy-email helper and the relink dialog.
 */
'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Eraser, SearchX } from 'lucide-react';
import {
  AuraProvider,
  Button,
  DataTable,
  DropdownMenu,
  FilterBar,
  FilterSelect,
  IconButton,
  Tag,
  type ActiveFilter,
  type DataTableColumn,
} from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
// Import the Domain VO directly (NOT via the @/modules/events barrel)
// so this Client Component does not transitively pull infrastructure
// modules that reference Server-Component-only `next/cache` APIs.
import {
  PAYMENT_STATUSES,
  isPaymentStatus,
} from '@/modules/events/domain/value-objects/payment-status';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { EmptyState } from '@/components/shell/empty-state';
import type {
  MatchType,
  PaymentStatus,
  RegistrationId,
  AttendeeEmail,
  EventId,
} from '@/modules/events';
import type { MemberId } from '@/modules/members';
import { MatchStatusBadge } from './match-status-badge';
import { QuotaEffectBadge } from './quota-effect-badge';
import { RelinkRegistrationDialog } from './relink-registration-dialog';
import { ErasePiiDialog } from './erase-pii-dialog';
import { ATTENDEE_COLUMN_LAYOUT } from './attendee-table-columns';

export type AttendeeRow = {
  // Brand types propagated through the Server→Client prop boundary.
  // Compile-only — no runtime cost. Round-1 review fix (type-H3):
  // `currentMatchedMemberId` is now branded `MemberId | null` so the
  // brand survives all the way to the dialog → fetch URL composition
  // (template-literal coercion happens at the URL boundary, not at
  // the component prop boundary).
  readonly registrationId: RegistrationId;
  readonly attendeeEmail: AttendeeEmail;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly matchType: MatchType;
  readonly ticketType: string | null;
  readonly ticketPriceThb: number | null;
  readonly paymentStatus: PaymentStatus;
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
  readonly isOverQuota: boolean;
  readonly registeredAt: string;
  /**
   * F6 Phase 9 / US6 — admin relink target. `null` when the row is
   * `non_member` / `unmatched`.
   */
  readonly currentMatchedMemberId: MemberId | null;
  /**
   * F6 Phase 9 / US6 / FR-014 round-2 R4 — true when the row's PII has
   * been retention-purged; the per-row relink action is replaced by an
   * inline disallowed message.
   */
  readonly isPseudonymised: boolean;
};

type Props = {
  readonly rows: readonly AttendeeRow[];
  readonly unmatchedOnly: boolean;
  readonly initialSearch: string;
  /**
   * F6.1 follow-up 2026-05-18 — initial selected `payment_status`
   * for the toolbar Select. `undefined` (or omitted) = "All
   * statuses" (no filter). R2-5 narrowed from `string` to
   * `PaymentStatus | ''`; R3-Y3 further dropped the empty-string
   * lane so the prop boundary is single-axis nullability — pass
   * `undefined` (or omit) to disable the filter. The empty-string
   * sentinel is now an internal concern of the `<Select>` widget
   * inside this component.
   */
  readonly initialPaymentStatus?: PaymentStatus;
  /**
   * F6 Phase 9 / US6 — required by the relink dialog so it can POST to
   * the per-event route. Branded `EventId | null` (Round-1 type-H3
   * fix) — `null` only on the manager read-only render path which
   * hides the Actions column entirely.
   */
  readonly eventId: EventId | null;
  /**
   * F6 Phase 9 / US6 — hides the Actions column when false (manager
   * read-only view per FR-035). When `eventId` is null this is also
   * forced to false defensively.
   */
  readonly canRelink: boolean;
  /**
   * Spec 122 US9a — every attendee matching the filters, across the pages:
   * the filter bar's count. Defaults to the rows shown.
   */
  readonly totalCount?: number;
};

// R3-Y1 (2026-05-18 /speckit-review Round 3 Final) — module-level
// constants so closure-capture warnings on useCallback hooks below
// don't fire. The values are stable across renders, so hoisting them
// out of the component body is the cleanest fix. Note: the
// `react-hooks/exhaustive-deps` disable at the R4-C1 useEffect below
// is a SEPARATE concern (the URL-guard intentionally re-runs only on
// `rawPaymentStatus` changes).
const ALL_STATUSES_SENTINEL = '__all__' as const;
// R4-I4 (2026-05-18 /speckit-review Round 4) — REAL compile-time
// disjointness check. `Extract<typeof X, Y> extends never ? true :
// false` evaluates to `true` ONLY when X is disjoint from Y. R3-Y1's
// `satisfies Exclude<string, PaymentStatus>` was a TS no-op:
// `Exclude<string, 'paid' | 'pending' | …>` simplifies to `string`,
// so the satisfies clause only checked `'__all__' is string` (trivially
// true). The threat model "future PaymentStatus addition collides
// with `'__all__'`" was unprotected. If PaymentStatus ever extends
// to include `'__all__'`, `Extract<'__all__', PaymentStatus>` returns
// `'__all__'` (not `never`), `_AssertSentinelDisjoint` collapses to
// `false`, and `const _disjoint: false = true` fails the build.
type _AssertSentinelDisjoint =
  Extract<typeof ALL_STATUSES_SENTINEL, PaymentStatus> extends never
    ? true
    : false;
const _disjoint: _AssertSentinelDisjoint = true;
void _disjoint;

const FILTER_PARAM_KEYS = ['q', 'paymentStatus', 'unmatchedOnly'] as const;

function formatRegisteredAt(iso: string, locale: string): string {
  return formatLocalisedDate(iso, locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function formatTicketPrice(thb: number | null, locale: string): string {
  if (thb === null) return '—';
  if (thb === 0) return '฿0';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 0,
  }).format(thb);
}

export function AttendeeTable({
  rows,
  unmatchedOnly,
  initialSearch,
  initialPaymentStatus,
  eventId,
  canRelink,
  totalCount,
}: Props) {
  const t = useTranslations('admin.events.detail.attendees');
  // Defensive AND — never render the Actions column if eventId is
  // missing even when canRelink was passed true (the dialog would
  // POST to /api/admin/events//... and 404 immediately).
  const showActions = canRelink && eventId !== null;
  const tMatchType = useTranslations('admin.events.matchType');
  const tMatchTypeTip = useTranslations('admin.events.matchTypeTooltip');
  const tQuota = useTranslations('admin.events.quotaEffect');
  const tQuotaTip = useTranslations('admin.events.quotaEffectTooltip');
  const tPay = useTranslations('admin.events.paymentStatus');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const barRef = useRef<HTMLDivElement>(null);
  // R3-F5 — the search keeps focus in the row after a clear: the pressed
  // control unmounts once the results come back.
  // After a successful erase the row is gone; focus lands on the search.
  const searchInput = useCallback(
    () => barRef.current?.querySelector<HTMLInputElement>('input[type="search"]') ?? null,
    [],
  );
  const focusSearch = useCallback(() => {
    queueMicrotask(() =>
      barRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus(),
    );
  }, []);

  // R3-F1 (2026-05-18 /speckit-review Round 3 Final) — UI feedback for
  // the silent paymentStatus URL guard drop. Pre-R3-F1, an admin who
  // pasted a URL with an invalid `?paymentStatus=junk` saw the table
  // load with the filter silently dropped (logger.debug captured the
  // event server-side but no user-visible signal). Now: detect the
  // mismatch on mount, fire a toast.info, and replace the URL to
  // strip the stale param so refreshes don't re-fire.
  //
  // R4-C1 (2026-05-18 /speckit-review Round 4) — dep changed from
  // `[searchParams]` (object identity, changes every render in Next.js
  // 16 App Router → infinite-loop risk if router.replace ever fails)
  // to `[rawPaymentStatus]` (scalar value, stable identity). Plus
  // try/catch around `router.replace` so a transient navigation
  // rejection emits a console.warn instead of stacking toasts forever.
  // R4-U1 — toast.warning → toast.info (recovery info, not user-
  // actionable warning per ux-standards.md § 6).
  const rawPaymentStatus = searchParams.get('paymentStatus');
  useEffect(() => {
    if (
      rawPaymentStatus !== null &&
      rawPaymentStatus !== '' &&
      !isPaymentStatus(rawPaymentStatus)
    ) {
      toast.info(t('paymentStatusFilterDropped'));
      try {
        const next = new URLSearchParams(searchParams.toString());
        next.delete('paymentStatus');
        next.delete('page');
        const qs = next.toString();
        router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
      } catch (e) {
        // Client-side fallback log — `@/lib/logger` is pino + Node so
        // can't be imported into client bundles cleanly. console.warn
        // is the universal sink; Sentry browser SDK (if mounted) will
        // capture it automatically.
        console.warn(
          '[F6.1] router.replace to strip invalid paymentStatus failed',
          e,
        );
      }
    }
    // Intentionally omit `t`, `pathname`, `router`, `searchParams`
    // from deps — these are stable / re-derived from rawPaymentStatus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawPaymentStatus]);

  const writeUrl = useCallback(
    (patch: Readonly<Record<string, string | null>>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      next.delete('page');
      const qs = next.toString();
      startTransition(() => {
        // In place, as every list's filters: no history entry per pick, no jump.
        router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
      });
    },
    [searchParams, pathname, router],
  );

  // F6.1 follow-up — paymentStatus filter (single-value select). The "all"
  // choice travels as the `__all__` sentinel (R3-Y1 / R4-I4 disjointness
  // check above) and is stripped before the URL write; the server page
  // validates the value with `isPaymentStatus()` (fail-safe drop).
  const onPaymentStatusChange = useCallback(
    (next: string | null) => {
      writeUrl({
        paymentStatus:
          next === null || next === '' || next === ALL_STATUSES_SENTINEL ? null : next,
      });
    },
    [writeUrl],
  );

  // P5 (round-10 ui-design-specialist) — copy-to-clipboard helper for
  // attendee emails. mailto: behaviour was unreliable on staff machines
  // without a default mail client; admins almost always paste into
  // CRM/spreadsheet anyway. Falls back to a manual-copy toast when the
  // async Clipboard API is unavailable (insecure context / iOS WebView).
  const copyEmail = useCallback(
    async (email: string) => {
      try {
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(email);
          toast.success(t('copyEmailSuccess'));
        } else {
          toast.error(t('copyEmailFailed'));
        }
      } catch {
        toast.error(t('copyEmailFailed'));
      }
    },
    [t],
  );

  // R3 simplify (2026-05-18) — single source of truth for the URL
  // keys that count as an "active filter" on this table. Drives both
  // the empty-state Clear-filters CTA visibility AND its click
  // handler, so adding a future filter key only needs to be done in
  // one place.
  const hasAnyFilter = FILTER_PARAM_KEYS.some((k) => searchParams.has(k));
  const clearAllFilters = useCallback(
    (announce: boolean) => {
      writeUrl(Object.fromEntries(FILTER_PARAM_KEYS.map((k) => [k, null])));
      // R4-U2 — the empty state's CTA announces "Filters cleared" before
      // focus moves to the search; the bar's own Clear needs no toast (the
      // count it carries is announced).
      if (announce) toast.success(t('filtersCleared'));
      focusSearch();
    },
    [writeUrl, t, focusSearch],
  );

  const activeFilters: ActiveFilter[] = [];
  if (initialSearch.trim() !== '') {
    activeFilters.push({
      id: 'q',
      label: t('filterChipSearch', { q: initialSearch.trim() }),
      onRemove: () => {
        writeUrl({ q: null });
        focusSearch();
      },
    });
  }
  if (initialPaymentStatus !== undefined) {
    activeFilters.push({
      id: 'paymentStatus',
      label: t('filterChip', { label: t('paymentStatusFilter'), value: tPay(initialPaymentStatus) }),
      onRemove: () => {
        writeUrl({ paymentStatus: null });
        focusSearch();
      },
    });
  }

  const barStrings = useMemo(
    () => ({
      clearFilters: t('clearFilters'),
      remove: (label: string) => t('removeFilterAria', { label }),
    }),
    [t],
  );

  const columns = useMemo<DataTableColumn<AttendeeRow>[]>(() => {
    const base: DataTableColumn<AttendeeRow>[] = [
      {
        key: 'attendee',
        label: t('columns.attendee'),
        ...ATTENDEE_COLUMN_LAYOUT.attendee,
        render: (r) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{r.attendeeName}</span>
            {/* P5 (round-10) — the email copies to the clipboard (copy-to-CRM
                is the daily flow); it keeps the link look. */}
            <button
              type="button"
              onClick={() => {
                void copyEmail(r.attendeeEmail);
              }}
              className="group relative inline-flex w-fit max-w-full items-center gap-1 rounded-[var(--aura-radius-sm)] max-sm:before:absolute max-sm:before:inset-x-0 max-sm:before:-inset-y-3.5 max-sm:before:content-[''] text-start text-[var(--aura-fg-accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]"
              aria-label={t('copyEmailAria', { email: r.attendeeEmail })}
              title={t('copyEmail')}
            >
              <span className="aura-text-caption min-w-0 break-all underline-offset-2 group-hover:underline">
                {r.attendeeEmail}
              </span>
              <Copy
                aria-hidden="true"
                className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
              />
            </button>
            {r.attendeeCompany && (
              <span className="aura-text-caption text-[var(--aura-fg-secondary)]">{r.attendeeCompany}</span>
            )}
          </div>
        ),
      },
      {
        key: 'match',
        label: t('columns.match'),
        ...ATTENDEE_COLUMN_LAYOUT.match,
        render: (r) => (
          <MatchStatusBadge
            matchType={r.matchType}
            label={tMatchType(r.matchType)}
            tooltip={tMatchTypeTip(r.matchType)}
          />
        ),
      },
      {
        key: 'ticket',
        label: t('columns.ticket'),
        ...ATTENDEE_COLUMN_LAYOUT.ticket,
        render: (r) => (
          <div className="flex flex-col gap-0.5">
            <span>{r.ticketType ?? '—'}</span>
            <span
              className={
                r.paymentStatus === 'refunded'
                  ? 'aura-text-caption text-[var(--aura-fg-danger)]'
                  : 'aura-text-caption text-[var(--aura-fg-secondary)]'
              }
            >
              {/* F6.1 UX-fix 2026-05-16 — no leading "— · " when the price is
                  unknown (EventCreate CSV rows carry no structured pricing). */}
              {r.ticketPriceThb !== null && (
                <>
                  {formatTicketPrice(r.ticketPriceThb, locale)}
                  <span aria-hidden="true"> · </span>
                </>
              )}
              {tPay(r.paymentStatus)}
            </span>
          </div>
        ),
      },
      {
        key: 'quota',
        label: t('columns.quota'),
        ...ATTENDEE_COLUMN_LAYOUT.quota,
        render: (r) => (
          <div className="flex flex-wrap gap-1">
            {r.countedAgainstPartnership && (
              <QuotaEffectBadge kind="partnership" label={tQuota('partnership')} tooltip={tQuotaTip('partnership')} />
            )}
            {r.countedAgainstCulturalQuota && (
              <QuotaEffectBadge kind="cultural" label={tQuota('cultural')} tooltip={tQuotaTip('cultural')} />
            )}
            {r.isOverQuota && (
              <QuotaEffectBadge kind="over_quota" label={tQuota('overQuota')} tooltip={tQuotaTip('overQuota')} />
            )}
            {!r.countedAgainstPartnership && !r.countedAgainstCulturalQuota && !r.isOverQuota && (
              <QuotaEffectBadge kind="none" label={tQuota('none')} tooltip={tQuotaTip('none')} />
            )}
          </div>
        ),
      },
      {
        key: 'registered',
        label: t('columns.registered'),
        ...ATTENDEE_COLUMN_LAYOUT.registered,
        render: (r) => (
          <span className="text-[var(--aura-fg-secondary)]">{formatRegisteredAt(r.registeredAt, locale)}</span>
        ),
      },
    ];
    if (!showActions || eventId === null) return base;
    return [
      ...base,
      {
        key: 'actions',
        label: t('columns.actions'),
        ...ATTENDEE_COLUMN_LAYOUT.actions,
        // Relink stays on every row; "Erase personal data" sits in the row's
        // "More" menu (board Admin-event-detail, spec 122 US9b-1 T923). On a
        // phone (the card foot) Relink takes the width beside the ⋯ button.
        render: (r) => (
          <AttendeeRowActions
            row={r}
            eventId={eventId}
            searchInput={searchInput}
            moreLabel={t('moreActionsAria', { attendeeName: r.attendeeName })}
            eraseLabel={t('eraseMenuItem')}
          />
        ),
      },
    ];
  }, [t, tMatchType, tMatchTypeTip, tQuota, tQuotaTip, tPay, locale, showActions, eventId, copyEmail, searchInput]);

  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]" aria-busy={isPending}>
      <AuraProvider strings={barStrings}>
        <FilterBar
          ref={barRef}
          label={t('heading')}
          searchGrow
          search={initialSearch}
          searchLabel={t('searchLabel')}
          searchPlaceholder={t('searchPlaceholder')}
          onSearchChange={(value: string) => writeUrl({ q: value.trim() || null })}
          filters={activeFilters}
          {...(activeFilters.length > 0 ? { onClearAll: () => clearAllFilters(false) } : {})}
          resultCount={t('resultCount', { count: totalCount ?? rows.length })}
        >
          {/* The board's short word on a phone; the full name stays (WCAG 2.5.3). */}
          <Tag
            selected={unmatchedOnly}
            touchHeight
            aria-label={t('showUnmatchedOnly')}
            onClick={() => writeUrl({ unmatchedOnly: unmatchedOnly ? null : '1' })}
          >
            <span className="max-sm:hidden">{t('showUnmatchedOnly')}</span>
            <span className="sm:hidden">{t('showUnmatchedOnlyShort')}</span>
          </Tag>
          <FilterSelect
            label={t('paymentStatusFilter')}
            allLabel={t('allShort')}
            value={initialPaymentStatus === undefined ? ALL_STATUSES_SENTINEL : initialPaymentStatus}
            onChange={onPaymentStatusChange}
            options={[
              { value: ALL_STATUSES_SENTINEL, label: t('allPaymentStatuses') },
              ...PAYMENT_STATUSES.map((s) => ({ value: s, label: tPay(s) })),
            ]}
          />
          {unmatchedOnly && activeFilters.length === 0 ? (
            <Button variant="ghost" size="sm" icon="x" touchHeight onClick={() => clearAllFilters(false)}>
              {t('clearFilters')}
            </Button>
          ) : null}
        </FilterBar>
      </AuraProvider>

      {rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t('emptyHeading')}
          description={t('empty')}
          bordered={false}
          // The bar's count already announces the change.
          announce={false}
          action={
            // R2-S1 — a one-click path back to the unfiltered table when the
            // empty result comes from a filter; none for "no attendees yet".
            hasAnyFilter ? (
              <Button variant="secondary" touchHeight onClick={() => clearAllFilters(true)}>
                {t('clearFilters')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable<AttendeeRow>
          label={t('tableCaption')}
          rows={[...rows]}
          columns={columns}
          rowKey="registrationId"
          manual
          rowHeight="auto"
          stackBelow={640}
          // Edge to edge inside the attendees card from 640px up; the pager follows.
          bleed
        />
      )}
    </div>
  );
}

/**
 * A row's actions: "Relink", then the ⋯ "More" menu holding "Erase personal
 * data" (FR-032a). DV-6: a pseudonymised row has no erase action — the erase
 * page redirects an already-purged row away and re-erasure is an idempotent
 * no-op — so it gets no menu at all.
 */
function AttendeeRowActions({
  row,
  eventId,
  searchInput,
  moreLabel,
  eraseLabel,
}: {
  readonly row: AttendeeRow;
  readonly eventId: EventId;
  readonly searchInput: () => HTMLElement | null;
  readonly moreLabel: string;
  readonly eraseLabel: string;
}) {
  const [eraseOpen, setEraseOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-row-actions=""
      className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full max-sm:[&>button:first-of-type]:flex-1"
    >
      <RelinkRegistrationDialog
        registrationId={row.registrationId}
        eventId={eventId}
        attendeeName={row.attendeeName}
        attendeeEmail={row.attendeeEmail}
        currentMatchedMemberId={row.currentMatchedMemberId}
        isPseudonymised={row.isPseudonymised}
      />
      {!row.isPseudonymised && (
        <>
          <DropdownMenu
            label={moreLabel}
            trigger={
              <IconButton
                ref={moreRef}
                icon="ellipsis"
                size="sm"
                touchHeight
                label={moreLabel}
                data-testid={`attendee-more-${row.registrationId}`}
              />
            }
            items={[{ label: eraseLabel, icon: <Eraser aria-hidden />, tone: 'danger', onSelect: () => setEraseOpen(true) }]}
          />
          <ErasePiiDialog
            eventId={eventId}
            registrationId={row.registrationId}
            attendeeName={row.attendeeName}
            open={eraseOpen}
            onOpenChange={setEraseOpen}
            finalFocus={moreRef}
            successFocus={searchInput}
          />
        </>
      )}
    </div>
  );
}
