'use client';

/**
 * Pass A · Section 1 — Renewal & Health card (presentational, client-safe).
 *
 * Fed plain serializable props by the async server wrapper
 * (`MemberRenewalHealthSection`). Surfaces the member's current renewal
 * posture (status + expiry + days remaining) AND the F9 engagement score so
 * an admin on a renewal call never has to leave for `/admin/renewals` to
 * answer "is this member renewing, and how healthy are they?".
 *
 * Accessibility (FR-035 / WCAG 1.4.1): the cycle status and the engagement
 * band are rendered as visible TEXT labels, never colour-alone. The Badge
 * variant is decorative; the localised label carries the meaning.
 *
 * Localisation: the expiry date is formatted via next-intl `useFormatter`
 * so th-TH renders Buddhist-Era years (display-only) — the prop is an ISO
 * 8601 UTC string, never a pre-formatted/raw `.toISOString()` slice.
 */
import Link from 'next/link';
import { ArrowRightIcon, CalendarClockIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import type { CycleStatus } from '@/modules/renewals/client';
import type { EngagementBand } from '@/modules/insights';

export interface RenewalHealthCardProps {
  /**
   * 056 fix #1 — id wired to the wrapping `<section aria-labelledby>` so the
   * card title is a real `<h2>` in the heading tree (SR heading-nav).
   */
  readonly headingId: string;
  /** Cycle status, or null when the member has no renewal cycle. */
  readonly status: CycleStatus | null;
  /** ISO 8601 UTC expiry instant, or null. Localised at render time. */
  readonly expiryIso: string | null;
  /** Days to expiry (negative = overdue), or null when no cycle. */
  readonly daysRemaining: number | null;
  /** F9 engagement score 0–100 (null when un-scored OR F9 flag off). */
  readonly engagementScore: number | null;
  readonly engagementBand: EngagementBand | null;
  /** Deep link to the renewals dashboard (or the specific cycle). */
  readonly viewHref: string;
}

/** Decorative Badge variant per cycle status (label still carries meaning). */
function statusVariant(
  status: CycleStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'lapsed':
    case 'cancelled':
      return 'destructive';
    case 'awaiting_payment':
    case 'pending_admin_reactivation':
      return 'outline';
    case 'upcoming':
    case 'reminded':
    default:
      return 'secondary';
  }
}

export function RenewalHealthCard({
  headingId,
  status,
  expiryIso,
  daysRemaining,
  engagementScore,
  engagementBand,
  viewHref,
}: RenewalHealthCardProps): React.ReactElement {
  const t = useTranslations('admin.members.detail.renewalHealth');
  const tBand = useTranslations('admin.members.directory.engagementBand');
  const format = useFormatter();

  const hasEngagement = engagementScore !== null && engagementBand !== null;

  return (
    <section aria-labelledby={headingId} className="h-full">
      <Card className="h-full flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        {/* 056 fix #1 — real <h2> (not the CardTitle <div>) so this section
            appears in the SR heading tree under the page <h1>. Carries the
            CardTitle font classes so the visual is unchanged. */}
        <h2
          id={headingId}
          className="flex items-center gap-2 font-heading text-base font-medium leading-snug"
        >
          <CalendarClockIcon className="size-4" aria-hidden="true" />
          {t('title')}
        </h2>
        <Link
          href={viewHref}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('viewRenewal')}
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </CardHeader>
      <CardContent>
        {status === null ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{t('status')}</dt>
              <dd>
                <Badge variant={statusVariant(status)}>
                  {t(`cycleStatus.${status}`)}
                </Badge>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs text-muted-foreground">{t('expiry')}</dt>
              <dd className="text-sm">
                {expiryIso !== null ? (
                  <div className="flex flex-col">
                    <span>
                      {format.dateTime(new Date(expiryIso), {
                        year: 'numeric',
                        month: 'short',
                        day: '2-digit',
                      })}
                    </span>
                    {daysRemaining !== null && (
                      <span className="text-caption text-muted-foreground">
                        {daysRemaining < 0
                          ? t('overdueDays', { days: Math.abs(daysRemaining) })
                          : t('daysRemaining', { days: daysRemaining })}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </dd>
            </div>
            {hasEngagement && (
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">
                  {t('engagement')}
                </dt>
                <dd className="flex items-center gap-2 text-sm">
                  <span className="font-medium tabular-nums">
                    {format.number(engagementScore)}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {tBand(engagementBand)}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        )}
      </CardContent>
      </Card>
    </section>
  );
}
