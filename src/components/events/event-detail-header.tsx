/**
 * Event detail header (F6 Phase 4 / US2 AS2-AS3 + ui-design-specialist
 * round-10 C2/C4-lite/P1 fixes).
 *
 * Displays the event metadata + a HERO match-rate scorecard + "View on
 * EventCreate" deep-link button + a slot for admin-only event actions
 * (Phase 6 toggles + archive, passed in by the page).
 *
 * Match-rate elevation (C2):
 *   - Rendered as text-h2 with colour-band caption beneath
 *   - Bands: ≥80% emerald · 50-79% amber · <50% destructive · 0 reg muted
 *   - Colour is decorative — band caption + raw matched/total give the
 *     same signal to screen readers (WCAG 1.4.1 non-colour-alone)
 *
 * Actions slot (C4-lite):
 *   - Optional `actions` prop (ReactNode); when present rendered inside a
 *     bordered footer strip with an h2 sr-only landmark. Keeps the Phase
 *     6 EventCategoryToggles + ArchiveEventButton invocations intact
 *     while collapsing them visually into the same card as the rest of
 *     the event header.
 *
 * P1 — Last updated:
 *   - Wrapped in <Tooltip> explaining the value is the last sync
 *     timestamp from any source — webhook ingest, CSV import, or
 *     admin metadata mutation (toggle / archive). Trust signal for
 *     ops triage; see `events.last_updated_at` field JSDoc below.
 *
 * Spec 122 US9a (T903): on AURA as the `Admin-event-detail` board draws it —
 * one AURA card (date and category, the badges, the match-rate figure with
 * its band, total registrations, last updated, "View on EventCreate") with
 * the actions at its end. On a phone the page repeats the actions in an
 * "Event actions" section at its end and this card hides its own
 * (`actionsHiddenBelowSm`).
 *
 * a11y:
 * - Match-rate metric uses <dl> + sr-only matchRateValue so SRs hear
 *   "Match rate 90% (18 of 20 attendees matched)" in one phrase.
 * - Deep-link is target="_blank" rel="noopener noreferrer" with an
 *   sr-only "(opens in a new tab)" note.
 */
'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ExternalLink, Award, Sparkles, Info } from 'lucide-react';
import { Badge, Card, Tooltip, buttonClass } from '@jirawatpyk/aura-react';
import { formatLocalisedDate } from '@/lib/format-date-localised';

export type EventHeaderProps = {
  readonly event: {
    readonly eventId: string;
    readonly name: string;
    readonly startDate: string;
    readonly category: string | null;
    readonly totalRegistrations: number;
    readonly matchedRegistrations: number;
    readonly matchRatePct: number;
    readonly isPartnerBenefit: boolean;
    readonly isCulturalEvent: boolean;
    readonly archivedAt: string | null;
    readonly eventcreateUrl: string | null;
    /**
     * `events.last_updated_at` — bumped to `now()` by
     * `drizzle-events-repository.findOrCreateEvent` on every attendee
     * upsert (both webhook ingest AND CSV import paths call into it),
     * and by admin event-metadata mutations (toggle / archive). So
     * this stamp answers "when did this row or its attendees last
     * change?" — NOT "when did Zapier last fire". Tooltip i18n key
     * `admin.events.detail.lastUpdatedAtTooltip` reflects that.
     */
    readonly lastUpdatedAt: string;
  };
  /**
   * Optional admin-action slot — Phase 6 toggles + archive buttons.
   * Rendered as a bordered footer strip inside the card when present.
   */
  readonly actions?: ReactNode;
  /**
   * The page repeats `actions` in an "Event actions" section at its end on a
   * phone (board `Admin-event-detail-mobile`); the card then hides its own
   * below 640px.
   */
  readonly actionsHiddenBelowSm?: boolean;
};

type MatchRateBand = 'high' | 'medium' | 'low' | 'none';

function bandForPct(total: number, pct: number): MatchRateBand {
  if (total <= 0) return 'none';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

// The band's colour on AURA's tokens; the caption beside it carries the meaning.
const BAND_TEXT_CLASS: Record<MatchRateBand, string> = {
  high: 'text-[var(--aura-fg-success)]',
  medium: 'text-[var(--aura-fg-warning)]',
  low: 'text-[var(--aura-fg-danger)]',
  none: 'text-[var(--aura-fg-secondary)]',
};

function formatDate(iso: string, locale: string): string {
  return formatLocalisedDate(iso, locale, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

export function EventDetailHeader({ event, actions, actionsHiddenBelowSm = false }: EventHeaderProps) {
  const t = useTranslations('admin.events.detail');
  const locale = useLocale();
  const isArchived = event.archivedAt !== null;
  const total = event.totalRegistrations;
  const matched = event.matchedRegistrations;
  const band = bandForPct(total, event.matchRatePct);
  const pctDisplay = total > 0 ? `${event.matchRatePct.toFixed(1)}%` : '—';
  const matchRateAria =
    total > 0
      ? t('header.matchRateValue', {
          pct: event.matchRatePct.toFixed(1),
          matched,
          total,
        })
      : t('header.matchRateNone');
  const stackedLabel =
    total > 0
      ? t('header.matchRateValueStacked', { matched, total })
      : t('header.matchRateNone');
  const bandKey = `header.matchRateBand${band.charAt(0).toUpperCase()}${band.slice(1)}` as const;
  const bandLabel = total > 0 ? t(bandKey) : t('header.matchRateNone');

  const muted = 'text-[var(--aura-fg-secondary)]';
  return (
    <Card>
      <div className="flex flex-col gap-[var(--aura-space-4)]">
        <div className="flex flex-wrap items-start justify-between gap-[var(--aura-space-4)]">
          {/*
           * heading dedupe — the page-level
           * <PageHeader title={event.name}/> already emits <h1>. Repeating
           * the same string as <h2> here pollutes the SR heading tree.
           * Render the metadata block without an extra heading level.
           */}
          <div className="flex flex-col gap-2">
            <div className={`aura-text-label flex flex-wrap items-center gap-2 ${muted}`}>
              <time dateTime={event.startDate}>{formatDate(event.startDate, locale)}</time>
              {event.category && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{event.category}</span>
                </>
              )}
            </div>
            {/* P6 fix — badges share a single flex row so Archived sits
                alongside Partner / Cultural with consistent gap+wrap. */}
            <div className="flex flex-wrap items-center gap-1">
              {isArchived && (
                <Badge variant="outline" tone="neutral">
                  {t('header.archived')}
                </Badge>
              )}
              {event.isPartnerBenefit && (
                <Badge tone="accent" icon={<Award aria-hidden />}>
                  {t('header.partnerBenefit')}
                </Badge>
              )}
              {event.isCulturalEvent && (
                <Badge tone="success" icon={<Sparkles aria-hidden />}>
                  {t('header.culturalEvent')}
                </Badge>
              )}
            </div>
          </div>
          {event.eventcreateUrl && (
            <Link
              href={event.eventcreateUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClass({ variant: 'secondary', className: 'max-sm:w-full' })}
            >
              <ExternalLink aria-hidden="true" className="size-4" />
              <span>{t('header.viewOnEventCreate')}</span>
              <span className="sr-only">{t('header.opensInNewTab')}</span>
            </Link>
          )}
        </div>
        {/* C2 — hero match-rate scorecard: the big number, its matched/total
            line and band caption, and the metadata pairs on the right. Two
            sibling `<dl>`s (axe `only-dlitems` / `dlitem`, F6.1 R3). */}
        <div className="flex flex-col gap-[var(--aura-space-4)] border-t border-[var(--aura-border-default)] pt-[var(--aura-space-4)] sm:flex-row sm:items-end sm:justify-between">
          <dl className="flex flex-col gap-1">
            <dt className={`aura-text-label ${muted}`}>{t('header.matchRate')}</dt>
            <dd
              className={`aura-text-h2 font-semibold tabular-nums leading-none ${BAND_TEXT_CLASS[band]}`}
              aria-label={matchRateAria}
            >
              {pctDisplay}
              <span className="sr-only"> — {matchRateAria}</span>
              {/* The type class sits on an inner span: preflight's `small`
                  (80% of the h2 figure) would win over it on the element. */}
              <small className="mt-1 block">
                <span className={`aura-text-label font-normal ${muted}`}>{stackedLabel}</span>
              </small>
              <small className="mt-1 block">
                <span className={`aura-text-caption font-medium ${BAND_TEXT_CLASS[band]}`}>{bandLabel}</span>
              </small>
            </dd>
          </dl>
          <dl className="aura-text-table-cell flex flex-col gap-1 sm:items-end">
            <div className="flex items-baseline gap-2">
              <dt className={`whitespace-nowrap ${muted}`}>{t('header.totalRegistrations')}</dt>
              <dd className="font-semibold tabular-nums">{total.toLocaleString(locale)}</dd>
            </div>
            {/* P1 — last-updated with explanatory tooltip. */}
            <div className="flex items-baseline gap-2">
              <dt className={`whitespace-nowrap ${muted}`}>{t('header.lastUpdatedAt')}</dt>
              <dd className="flex items-center gap-1">
                <time dateTime={event.lastUpdatedAt}>{formatDate(event.lastUpdatedAt, locale)}</time>
                <Tooltip content={t('header.lastUpdatedAtTooltip')}>
                  <button
                    type="button"
                    className={`relative inline-flex size-6 items-center justify-center rounded-full before:absolute before:-inset-2.5 before:content-[''] ${muted} hover:text-[var(--aura-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--aura-focus-ring)]`}
                    aria-label={t('header.lastUpdatedAtTooltip')}
                  >
                    <Info aria-hidden="true" className="size-3.5" />
                  </button>
                </Tooltip>
              </dd>
            </div>
          </dl>
        </div>
        {/* C4-lite — admin actions at the card's end. When `actions` is
            undefined (manager view, or an archived event) the strip is
            omitted. On a phone the page shows them at its end instead. */}
        {actions && (
          <div
            className={`flex flex-wrap items-center gap-2 border-t border-[var(--aura-border-default)] pt-[var(--aura-space-4)]${
              actionsHiddenBelowSm ? ' max-sm:hidden' : ''
            }`}
          >
            <h2 className="sr-only">{t('header.actionsLabel')}</h2>
            {actions}
          </div>
        )}
      </div>
    </Card>
  );
}
