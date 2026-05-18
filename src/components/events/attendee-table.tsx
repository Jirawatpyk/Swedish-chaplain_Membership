/**
 * Attendee table (F6 Phase 4 / US2 AS2-AS4).
 *
 * Renders the paginated attendee list for an event detail page +
 * toolbar (search input + "Show unmatched only" toggle). Server-
 * side pagination + filter — the toolbar pushes URL params and the
 * server component re-renders.
 *
 * Columns:
 * - Attendee  (name + email + company stacked)
 * - Match     (MatchStatusBadge — 5 variants)
 * - Ticket    (type + price + payment status)
 * - Quota     (Partner / Cultural / Over-quota badges; can be
 * multiple)
 * - Registered (relative time, locale-formatted)
 *
 * a11y:
 * - Toolbar button has aria-pressed reflecting the URL state.
 * - sr-only caption + result-count announcement (aria-live).
 * - Empty rows path uses tabular role+aria semantics correctly
 * ("no matching rows").
 */
'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTransition, useState, useCallback, useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
// Import the Domain VO directly (NOT via the @/modules/events barrel)
// so this Client Component does not transitively pull infrastructure
// modules that reference Server-Component-only `next/cache` APIs.
import { PAYMENT_STATUSES } from '@/modules/events/domain/value-objects/payment-status';
import { TooltipProvider } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatLocalisedDate } from '@/lib/format-date-localised';
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
   * for the toolbar Select. Empty string = "All statuses" (no
   * filter). R2-5 (2026-05-18 /speckit-review Round 2) narrowed
   * from `string` to `PaymentStatus | ''` so the prop boundary
   * enforces the same closed set as the page-level
   * `isPaymentStatus` guard — drift cannot reintroduce arbitrary
   * URL strings.
   */
  readonly initialPaymentStatus?: PaymentStatus | '';
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
};

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
  initialPaymentStatus = '',
  eventId,
  canRelink,
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
  const [searchInput, setSearchInput] = useState(initialSearch);

  // Sync local state when URL changes externally (back/forward nav).
  useEffect(() => {
    setSearchInput(initialSearch);
  }, [initialSearch]);

  const pushUrl = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      startTransition(() => {
        router.push(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
      });
    },
    [pathname, router],
  );

  const toggleUnmatched = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    if (unmatchedOnly) {
      next.delete('unmatchedOnly');
    } else {
      next.set('unmatchedOnly', '1');
    }
    next.delete('page');
    pushUrl(next);
  }, [searchParams, unmatchedOnly, pushUrl]);

  // F6.1 follow-up — paymentStatus filter (single-value select).
  // Empty string == "All statuses" sentinel — Base UI `<Select>`
  // rejects empty string as a `value`, so we route the "all" choice
  // through the `__all__` sentinel and strip it before pushing to URL.
  // URL key is `paymentStatus`; server page validates with
  // `isPaymentStatus()` (anything off-list drops the filter
  // fail-safe).
  //
  // R2-5 (2026-05-18 /speckit-review Round 2) — `as const` plus the
  // compile-time disjointness guard below pins the sentinel string
  // to a fresh nominal literal that the type-checker forbids any
  // future PaymentStatus addition from colliding with.
  const ALL_STATUSES_SENTINEL = '__all__' as const;
  // Compile-time guard: sentinel must NOT be assignable to a
  // PaymentStatus member. If a future PaymentStatus literal happens
  // to be `'__all__'`, the `extends … ? never : true` collapses to
  // `never` and the `_disjointCheck` line fails the build.
  type _SentinelDisjoint =
    typeof ALL_STATUSES_SENTINEL extends PaymentStatus ? never : true;
  const _disjointCheck: _SentinelDisjoint = true;
  void _disjointCheck;
  const onPaymentStatusChange = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (next === null || next === '' || next === ALL_STATUSES_SENTINEL) {
        params.delete('paymentStatus');
      } else {
        params.set('paymentStatus', next);
      }
      params.delete('page');
      pushUrl(params);
    },
    [searchParams, pushUrl],
  );

  const submitSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const next = new URLSearchParams(searchParams.toString());
      const v = searchInput.trim();
      if (v) {
        next.set('q', v);
      } else {
        next.delete('q');
      }
      next.delete('page');
      pushUrl(next);
    },
    [searchInput, searchParams, pushUrl],
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

  // R2-3 (2026-05-18 /speckit-review Round 2) — local callback that
  // strips the `q` + `page` URL keys. Pre-R2 this body was duplicated
  // inline in BOTH the native-X clear path (Input onChange when v==='')
  // AND the Escape-key handler — same 4-line delete sequence. Folding
  // through one helper prevents the two paths drifting apart.
  const clearSearchUrl = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete('q');
    next.delete('page');
    pushUrl(next);
  }, [searchParams, pushUrl]);

  // R6-W12 staff-review fix (2026-05-13): clear-on-Escape handler.
  // `<Input type="search">` renders the native browser X clear button
  // on most desktop browsers but it is absent on iOS Safari and some
  // Android WebViews and has no keyboard equivalent. The Escape key
  // both clears the local input state AND strips `q` + `page` from
  // the URL so the table snaps back to the unfiltered view. No-op
  // when the input is already empty (avoids a useless URL push).
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Escape') return;
      if (searchInput === '' && !searchParams.has('q')) return;
      e.preventDefault();
      setSearchInput('');
      clearSearchUrl();
    },
    [searchInput, searchParams, clearSearchUrl],
  );

  return (
    /* Round-11 review fix — single TooltipProvider hoisted here so
       MatchStatusBadge + QuotaEffectBadge inside row cells don't each
       instantiate their own provider (was 100+ providers on a 50-row
       page; tooltip race + Tab order noise). */
    <TooltipProvider>
    <div className="flex flex-col gap-4" aria-busy={isPending}>
      {/* Mobile: search takes full row, filter chips wrap to next.
          ≥sm: search + 2 chips share one row. The `min-w-0` on the
          form lets it shrink inside the flex parent without forcing
          horizontal scroll on narrow viewports. */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={submitSearch}
          className="flex w-full min-w-0 gap-2 sm:w-auto sm:flex-1"
        >
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => {
              const v = e.target.value;
              setSearchInput(v);
              // Bug-fix 2026-05-18 — the native <input type="search"> "X"
              // clear button fires onChange with v='' but does NOT submit
              // the form, so the URL-bound ?q= parameter would otherwise
              // stay stale and the server-rendered table stayed filtered
              // until the admin pressed Enter on the now-empty input.
              // Detect "value became empty while URL still has q" and
              // push the URL clear inline (same effect as the existing
              // Escape-key handler at handleSearchKeyDown). React's
              // onChange fires on every keystroke too, so users who
              // backspace down to empty also see the table refresh —
              // an expected affordance.
              if (v === '' && searchParams.has('q')) {
                clearSearchUrl();
              }
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={isPending}>
            {isPending && (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t('searchSubmit')}
          </Button>
        </form>
        <Button
          type="button"
          variant={unmatchedOnly ? 'default' : 'outline'}
          onClick={toggleUnmatched}
          aria-pressed={unmatchedOnly}
          disabled={isPending}
          className="w-full sm:w-auto"
        >
          {isPending && (
            <Loader2
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          )}
          {unmatchedOnly
            ? t('showUnmatchedOnlyActive')
            : t('showUnmatchedOnly')}
        </Button>
        <Select
          value={
            initialPaymentStatus === ''
              ? ALL_STATUSES_SENTINEL
              : initialPaymentStatus
          }
          onValueChange={onPaymentStatusChange}
          disabled={isPending}
        >
          <SelectTrigger
            className="w-full sm:w-[12rem]"
            aria-label={t('filterByPaymentStatusLabel')}
          >
            {/* TranslatedSelectValue maps the raw `value` (e.g.
                `'paid'` or the `__all__` sentinel) to a localised
                label so users never see the internal literal. */}
            <TranslatedSelectValue
              placeholder={t('filterByPaymentStatusLabel')}
              translate={(v) =>
                v === ALL_STATUSES_SENTINEL
                  ? t('allPaymentStatuses')
                  : tPay(v as Parameters<typeof tPay>[0])
              }
            />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUSES_SENTINEL}>
              {t('allPaymentStatuses')}
            </SelectItem>
            {PAYMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {tPay(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/*
       * result-count aria-live region —
       * announces row count to screen readers after filter/search changes.
       * `role="status"` + `aria-live="polite"` lets the SR queue the
       * update without interrupting; `aria-atomic` ensures the full
       * sentence is re-announced on every change.
       */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {t('resultCount', { count: rows.length })}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-border bg-card py-12 text-center">
          <p className="text-muted-foreground">{t('empty')}</p>
          {/* R2-S1 (2026-05-18 /speckit-review Round 2 Suggestion) —
              when any filter is set AND the result is empty, surface a
              "Clear filters" CTA so users have a one-click path back
              to the unfiltered table. Without filters set the empty
              state is a true "no attendees yet" surface, not a
              filter dead-end — no CTA in that case. */}
          {(searchParams.has('q') ||
            searchParams.has('paymentStatus') ||
            searchParams.has('unmatchedOnly')) && (
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => {
                const next = new URLSearchParams(searchParams.toString());
                next.delete('q');
                next.delete('paymentStatus');
                next.delete('unmatchedOnly');
                next.delete('page');
                setSearchInput('');
                pushUrl(next);
              }}
              disabled={isPending}
            >
              {t('clearFilters')}
            </Button>
          )}
        </div>
      ) : (
        // min-w sizing: 5 base columns (Attendee + Match + Ticket +
        // Quota + Registered) ~580px; Phase 9 adds an optional Actions
        // column (~80px when `showActions=true`). Bump to 660px so the
        // table fills its viewport on the admin-render path without
        // forcing horizontal scroll on mid-size laptop viewports.
        <Table className={cn(showActions ? 'min-w-[660px]' : 'min-w-[580px]')}>
          <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.attendee')}</TableHead>
              <TableHead>{t('columns.match')}</TableHead>
              <TableHead>{t('columns.ticket')}</TableHead>
              <TableHead>{t('columns.quota')}</TableHead>
              <TableHead>{t('columns.registered')}</TableHead>
              {showActions && (
                <TableHead>
                  <span className="sr-only">
                    {t('columns.actions')}
                  </span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.registrationId}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{r.attendeeName}</span>
                    {/* P5 (round-10) — email is now a button that copies
                        to clipboard. Admins reported mailto: rarely
                        useful; copy-to-CRM is the daily flow. The
                        button keeps the text-link visual treatment
                        for back-compat. */}
                    <button
                      type="button"
                      onClick={() => {
                        void copyEmail(r.attendeeEmail);
                      }}
                      className="group inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                      aria-label={t('copyEmailAria', {
                        email: r.attendeeEmail,
                      })}
                      title={t('copyEmail')}
                    >
                      <span className="underline-offset-2 group-hover:underline">
                        {r.attendeeEmail}
                      </span>
                      <Copy
                        aria-hidden="true"
                        className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
                      />
                    </button>
                    {r.attendeeCompany && (
                      <span className="text-xs text-muted-foreground">
                        {r.attendeeCompany}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <MatchStatusBadge
                    matchType={r.matchType}
                    label={tMatchType(r.matchType)}
                    tooltip={tMatchTypeTip(r.matchType)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span>{r.ticketType ?? '—'}</span>
                    <span
                      className={cn(
                        'text-xs',
                        r.paymentStatus === 'refunded'
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                      )}
                    >
                      {/*
                        F6.1 UX-fix 2026-05-16 — when `ticketPriceThb`
                        is null (common for EventCreate CSV imports
                        because EventCreate's adapter maps only Name /
                        Email / Notes / Status per FR-005-FR-010 and
                        does NOT carry structured ticket pricing),
                        drop the leading "— · " so the cell reads just
                        "Paid" instead of "— · Paid". Avoids a
                        malformed-pair visual ("dash bullet status")
                        that previously made the column look broken
                        on every EventCreate-format row.
                      */}
                      {r.ticketPriceThb !== null && (
                        <>
                          {formatTicketPrice(r.ticketPriceThb, locale)}
                          <span aria-hidden="true"> · </span>
                        </>
                      )}
                      {tPay(r.paymentStatus)}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {r.countedAgainstPartnership && (
                      <QuotaEffectBadge
                        kind="partnership"
                        label={tQuota('partnership')}
                        tooltip={tQuotaTip('partnership')}
                      />
                    )}
                    {r.countedAgainstCulturalQuota && (
                      <QuotaEffectBadge
                        kind="cultural"
                        label={tQuota('cultural')}
                        tooltip={tQuotaTip('cultural')}
                      />
                    )}
                    {r.isOverQuota && (
                      <QuotaEffectBadge
                        kind="over_quota"
                        label={tQuota('overQuota')}
                        tooltip={tQuotaTip('overQuota')}
                      />
                    )}
                    {!r.countedAgainstPartnership &&
                      !r.countedAgainstCulturalQuota &&
                      !r.isOverQuota && (
                        // R6-B4 staff-review fix (2026-05-13): dropped
                        // `text-muted-foreground` override which produced
                        // ~2:1 contrast on the white card (WCAG 1.4.3
                        // fail). Default `Badge variant="outline"` text
                        // already clears 4.5:1; outline-only border
                        // preserves the de-emphasis intent.
                        <Badge variant="outline" title={tQuotaTip('none')}>
                          {tQuota('none')}
                        </Badge>
                      )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRegisteredAt(r.registeredAt, locale)}
                </TableCell>
                {showActions && eventId !== null && (
                  <TableCell className="text-right">
                    <RelinkRegistrationDialog
                      registrationId={r.registrationId}
                      eventId={eventId}
                      attendeeName={r.attendeeName}
                      attendeeEmail={r.attendeeEmail}
                      currentMatchedMemberId={r.currentMatchedMemberId}
                      isPseudonymised={r.isPseudonymised}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
    </TooltipProvider>
  );
}
