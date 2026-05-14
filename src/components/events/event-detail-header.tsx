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
 *   - Wrapped in <Tooltip> explaining the value is the last Zapier
 *     delivery timestamp (trust signal for ops triage).
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
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatLocalisedDate } from '@/lib/format-date-localised';

type EventHeaderProps = {
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
    /** last Zapier delivery timestamp. */
    readonly lastUpdatedAt: string;
  };
  /**
   * Optional admin-action slot — Phase 6 toggles + archive buttons.
   * Rendered as a bordered footer strip inside the card when present.
   */
  readonly actions?: ReactNode;
};

type MatchRateBand = 'high' | 'medium' | 'low' | 'none';

function bandForPct(total: number, pct: number): MatchRateBand {
  if (total <= 0) return 'none';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

const BAND_NUMBER_CLASS: Record<MatchRateBand, string> = {
  high: 'text-emerald-700 dark:text-emerald-300',
  medium: 'text-amber-700 dark:text-amber-300',
  low: 'text-destructive',
  none: 'text-muted-foreground',
};

function formatDate(iso: string, locale: string): string {
  return formatLocalisedDate(iso, locale, {
    dateStyle: 'long',
    timeStyle: 'short',
  });
}

export function EventDetailHeader({ event, actions }: EventHeaderProps) {
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

  return (
    <TooltipProvider>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            {/*
             * heading dedupe — the page-level
             * <PageHeader title={event.name}/> already emits <h1>. Repeating
             * the same string as <h2> here pollutes the SR heading tree.
             * Render the metadata block without an extra heading level.
             */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <time dateTime={event.startDate}>
                  {formatDate(event.startDate, locale)}
                </time>
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
                  <Badge variant="outline" className="text-xs">
                    {t('header.archived')}
                  </Badge>
                )}
                {event.isPartnerBenefit && (
                  <Badge
                    variant="outline"
                    className="border-sky-600 text-sky-900 dark:border-sky-500 dark:text-sky-100"
                    aria-label={t('header.partnerBenefit')}
                  >
                    <Award aria-hidden="true" data-icon="inline-start" />
                    <span>{t('header.partnerBenefit')}</span>
                  </Badge>
                )}
                {event.isCulturalEvent && (
                  <Badge
                    variant="outline"
                    className="border-violet-600 text-violet-900 dark:border-violet-500 dark:text-violet-100"
                    aria-label={t('header.culturalEvent')}
                  >
                    <Sparkles aria-hidden="true" data-icon="inline-start" />
                    <span>{t('header.culturalEvent')}</span>
                  </Badge>
                )}
              </div>
            </div>
            {event.eventcreateUrl && (
              <Link
                href={event.eventcreateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                <ExternalLink
                  aria-hidden="true"
                  className="size-4"
                  data-icon="inline-start"
                />
                <span>{t('header.viewOnEventCreate')}</span>
                <span className="sr-only">{t('header.opensInNewTab')}</span>
              </Link>
            )}
          </div>
          {/* C2 — hero match-rate scorecard. Big number + band caption +
              secondary metadata strip on the right. */}
          <dl className="flex flex-col gap-4 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-col gap-1">
              <dt className="text-sm font-medium text-muted-foreground">
                {t('header.matchRate')}
              </dt>
              <dd
                className={cn(
                  'text-h2 font-semibold tabular-nums leading-none',
                  BAND_NUMBER_CLASS[band],
                )}
                aria-label={matchRateAria}
              >
                {pctDisplay}
                <span className="sr-only"> — {matchRateAria}</span>
              </dd>
              <p className="text-sm text-muted-foreground">{stackedLabel}</p>
              <p
                className={cn(
                  'text-xs font-medium',
                  band === 'high' &&
                    'text-emerald-700 dark:text-emerald-300',
                  band === 'medium' &&
                    'text-amber-700 dark:text-amber-300',
                  band === 'low' && 'text-destructive',
                  band === 'none' && 'text-muted-foreground',
                )}
              >
                {bandLabel}
              </p>
            </div>
            <div className="flex flex-col gap-1 text-sm sm:items-end">
              <div className="flex items-baseline gap-2">
                <dt className="whitespace-nowrap text-muted-foreground">
                  {t('header.totalRegistrations')}
                </dt>
                <dd className="font-semibold tabular-nums">
                  {total.toLocaleString(locale)}
                </dd>
              </div>
              {/* P1 — last-updated with explanatory tooltip. */}
              <div className="flex items-baseline gap-2">
                <dt className="whitespace-nowrap text-muted-foreground">
                  {t('header.lastUpdatedAt')}
                </dt>
                <dd className="flex items-center gap-1">
                  <time dateTime={event.lastUpdatedAt}>
                    {formatDate(event.lastUpdatedAt, locale)}
                  </time>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                          aria-label={t('header.lastUpdatedAtTooltip')}
                        />
                      }
                    >
                      <Info aria-hidden="true" className="size-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>
                      {t('header.lastUpdatedAtTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </dd>
              </div>
            </div>
          </dl>
          {/* C4-lite — admin actions slot. Rendered as a bordered footer
              when the page passes EventCategoryToggles + ArchiveEventButton.
              When `actions` is undefined (member/manager view, or archived
              event), the strip is omitted entirely. */}
          {actions && (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <h2 className="sr-only">{t('header.actionsLabel')}</h2>
              {actions}
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
