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
import { Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type {
  MatchType,
  RegistrationId,
  AttendeeEmail,
} from '@/modules/events';
import { MatchStatusBadge } from './match-status-badge';
import { QuotaEffectBadge } from './quota-effect-badge';

export type AttendeeRow = {
  // brand types propagated through the
  // Server→Client prop boundary. Compile-only — no runtime cost.
  readonly registrationId: RegistrationId;
  readonly attendeeEmail: AttendeeEmail;
  readonly attendeeName: string;
  readonly attendeeCompany: string | null;
  readonly matchType: MatchType;
  readonly ticketType: string | null;
  readonly ticketPriceThb: number | null;
  readonly paymentStatus: 'paid' | 'pending' | 'refunded' | 'free';
  readonly countedAgainstPartnership: boolean;
  readonly countedAgainstCulturalQuota: boolean;
  readonly isOverQuota: boolean;
  readonly registeredAt: string;
};

type Props = {
  readonly rows: readonly AttendeeRow[];
  readonly unmatchedOnly: boolean;
  readonly initialSearch: string;
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

export function AttendeeTable({ rows, unmatchedOnly, initialSearch }: Props) {
  const t = useTranslations('admin.events.detail.attendees');
  const tMatchType = useTranslations('admin.events.matchType');
  const tQuota = useTranslations('admin.events.quotaEffect');
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
      const next = new URLSearchParams(searchParams.toString());
      next.delete('q');
      next.delete('page');
      pushUrl(next);
    },
    [searchInput, searchParams, pushUrl],
  );

  return (
    <div className="flex flex-col gap-4" aria-busy={isPending}>
      <div className="flex flex-wrap items-center gap-2">
        <form onSubmit={submitSearch} className="flex flex-1 gap-2">
          <Input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel')}
            className="max-w-md"
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
        </div>
      ) : (
        <Table className="min-w-[580px]">
          <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.attendee')}</TableHead>
              <TableHead>{t('columns.match')}</TableHead>
              <TableHead>{t('columns.ticket')}</TableHead>
              <TableHead>{t('columns.quota')}</TableHead>
              <TableHead>{t('columns.registered')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.registrationId}>
                <TableCell>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium">{r.attendeeName}</span>
                    {/* L3 (verify-finding): plain <a> for non-route URLs —
                        next/link emits prefetch hints that are wasted on
                        mailto: schemes. */}
                    <a
                      href={`mailto:${r.attendeeEmail}`}
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                    >
                      {r.attendeeEmail}
                    </a>
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
                      {formatTicketPrice(r.ticketPriceThb, locale)}
                      <span aria-hidden="true"> · </span>
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
                      />
                    )}
                    {r.countedAgainstCulturalQuota && (
                      <QuotaEffectBadge
                        kind="cultural"
                        label={tQuota('cultural')}
                      />
                    )}
                    {r.isOverQuota && (
                      <QuotaEffectBadge
                        kind="over_quota"
                        label={tQuota('overQuota')}
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
                        <Badge variant="outline">
                          {tQuota('none')}
                        </Badge>
                      )}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatRegisteredAt(r.registeredAt, locale)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
