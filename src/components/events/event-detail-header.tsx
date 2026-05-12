/**
 * T062 — Event detail header (F6 Phase 4 / US2 AS2-AS3).
 *
 * Displays the event metadata + aggregate match-rate indicator
 * + "View on EventCreate" deep-link button + Archived badge.
 *
 * Pure render — receives the `event` DTO from `loadEventDetail`
 * and a localised set of strings via next-intl in the calling
 * page (this is a client component because it uses translations
 * + Intl.DateTimeFormat-ish locale helpers).
 *
 * a11y:
 *   - Match-rate is presented as `<dl>` so screen readers announce
 *     "Match rate: 90% (18 of 20)" in one phrase.
 *   - Deep-link is target="_blank" rel="noopener noreferrer"
 *     (security + a11y — also includes an sr-only "(opens in a
 *     new tab)" note).
 */
'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ExternalLink, Award, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
    /** U5 (verify-finding 2026-05-12): last Zapier delivery timestamp. */
    readonly lastUpdatedAt: string;
  };
};

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // M4 fix (verify-finding): Thai BE display via buddhist calendar.
  const lo = locale === 'th' || locale === 'th-TH' ? 'th-TH-u-ca-buddhist' : locale;
  return new Intl.DateTimeFormat(lo, {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(d);
}

export function EventDetailHeader({ event }: EventHeaderProps) {
  const t = useTranslations('admin.events.detail');
  const locale = useLocale();
  const isArchived = event.archivedAt !== null;
  const total = event.totalRegistrations;
  const matched = event.matchedRegistrations;
  const matchRateLabel =
    total <= 0
      ? '—'
      : t('header.matchRateValue', {
          pct: event.matchRatePct.toFixed(1),
          matched,
          total,
        });

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/*
           * U4 (verify-finding 2026-05-12): heading dedupe — the page-level
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
              {isArchived && (
                <Badge variant="outline" className="text-xs">
                  {t('header.archived')}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {event.isPartnerBenefit && (
                <Badge
                  variant="outline"
                  className="border-sky-500 text-sky-900 dark:border-sky-500 dark:text-sky-100"
                  aria-label={t('header.partnerBenefit')}
                >
                  <Award aria-hidden="true" data-icon="inline-start" />
                  <span>{t('header.partnerBenefit')}</span>
                </Badge>
              )}
              {event.isCulturalEvent && (
                <Badge
                  variant="outline"
                  className="border-violet-500 text-violet-900 dark:border-violet-500 dark:text-violet-100"
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
        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t pt-4 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="text-muted-foreground">{t('header.matchRate')}</dt>
            <dd className="font-semibold tabular-nums">{matchRateLabel}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="whitespace-nowrap text-muted-foreground">
              {t('header.totalRegistrations')}
            </dt>
            <dd className="font-semibold tabular-nums">
              {total.toLocaleString(locale)}
            </dd>
          </div>
          {/* U5: trust signal — last Zapier delivery timestamp */}
          <div className="flex items-baseline gap-2">
            <dt className="whitespace-nowrap text-muted-foreground">
              {t('header.lastUpdatedAt')}
            </dt>
            <dd>
              <time dateTime={event.lastUpdatedAt}>
                {formatDate(event.lastUpdatedAt, locale)}
              </time>
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
