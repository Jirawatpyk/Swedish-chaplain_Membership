'use client';

/**
 * Spec 122 US3 — the dashboard's "Benefit usage" card as the portal `Main` /
 * `Home-mobile` boards draw it: a bar per tracked benefit with its last use
 * as the bar's hint, the benefit's next step as a secondary button beside it
 * (under it on phones), and "Full benefits" as the last row of the body.
 *
 * Member-portal only: the admin member-detail preview keeps the shared
 * `BenefitUsageCard compact`. The under-use warning is left to the Benefits
 * stat beside this card (the board draws none here); the full benefits page
 * still shows it (FR-021).
 */
import Link from 'next/link';
import { ArrowRight, CalendarDays, Mail, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Progress } from '@jirawatpyk/aura-react';
import { Card, Icon as AuraIcon, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatCalendarYear, getDateFormatLocale } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import type { BenefitUsageItem } from './benefit-usage-card';

const ACTION_ICON: Readonly<Record<string, LucideIcon>> = {
  eblast: Mail,
  cultural_tickets: CalendarDays,
};

/**
 * A bar's item. `reserved` (E-Blasts only) is the count held by submitted,
 * not-yet-sent E-Blasts, from the quota counter: drawn as a striped segment
 * after the used one, with "N reserved · M left" as the hint.
 */
export type PortalBenefitsSummaryItem = BenefitUsageItem & { readonly reserved?: number };

export interface PortalBenefitsSummaryCardProps {
  readonly locale: string;
  readonly membershipYear: number;
  readonly quantifiable: readonly PortalBenefitsSummaryItem[];
  /** "Full benefits" — the member's benefits page. */
  readonly fullHref: string;
  readonly headingId?: string;
}

export function PortalBenefitsSummaryCard({
  locale,
  membershipYear,
  quantifiable,
  fullHref,
  headingId,
}: PortalBenefitsSummaryCardProps): React.ReactElement {
  const t = useTranslations('benefits');
  // `timeZone` pinned — the server and a Bangkok browser must agree on the day.
  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(getDateFormatLocale(locale), { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(
      new Date(iso),
    );

  return (
    <Card
      data-testid="benefit-usage-card"
      title={t('card.title', { year: formatCalendarYear(membershipYear, locale) })}
      description={t('card.liveNote')}
      headingLevel={2}
      {...(headingId ? { titleId: headingId } : {})}
    >
      <div className="flex flex-col gap-5">
        <ul className="flex flex-col gap-5">
          {quantifiable.map((b) => {
            const Icon = ACTION_ICON[b.key];
            return (
              <li key={b.key} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="min-w-0 flex-1">
                  {b.reserved !== undefined && b.reserved > 0 ? (
                    <ReservedProgress
                      label={t(`benefit.${b.key}`)}
                      used={b.used}
                      reserved={b.reserved}
                      total={b.entitlement}
                      valueLabel={t('card.usedOf', { used: b.used, total: b.entitlement })}
                      valueText={t('card.quotaValueText', {
                        used: b.used,
                        reserved: b.reserved,
                        remaining: Math.max(0, b.entitlement - b.used - b.reserved),
                        total: b.entitlement,
                      })}
                      hint={t('card.reservedHint', {
                        reserved: b.reserved,
                        remaining: Math.max(0, b.entitlement - b.used - b.reserved),
                        hasDate: b.lastUsedAt === null ? 'no' : 'yes',
                        date: b.lastUsedAt === null ? '' : formatDate(b.lastUsedAt),
                      })}
                    />
                  ) : (
                    <Progress
                      label={t(`benefit.${b.key}`)}
                      value={b.used}
                      max={b.entitlement}
                      showValue
                      valueLabel={t('card.usedOf', { used: b.used, total: b.entitlement })}
                      hint={b.lastUsedAt === null ? t('card.neverUsed') : t('card.lastUsed', { date: formatDate(b.lastUsedAt) })}
                    />
                  )}
                </div>
                {b.actionHref !== undefined ? (
                  <Link
                    href={b.actionHref}
                    className={cn(buttonClass({ variant: 'secondary' }), 'shrink-0 self-start no-underline sm:w-[148px] sm:self-auto')}
                  >
                    {Icon ? <AuraIcon name={<Icon />} size={16} /> : null}
                    {t(`benefit.action.${b.key}`)}
                  </Link>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div className="border-t border-[var(--aura-border-default)] pt-3">
          <Link
            href={fullHref}
            className="inline-flex min-h-11 items-center gap-1.5 aura-text-label text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline sm:min-h-0"
          >
            {t('card.fullBenefits')}
            <AuraIcon name={<ArrowRight />} size={16} />
          </Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * AURA's Progress with a second, striped segment for reserved E-Blasts (the
 * `Main` board): the same `aura-progress` markup and classes, so it matches
 * the bars beside it; `aria-valuetext` says all three counts. AURA's
 * `Progress` draws one bar: a stand-in until AURA #89 (reserved segment).
 */
function ReservedProgress({
  label,
  used,
  reserved,
  total,
  valueLabel,
  valueText,
  hint,
}: {
  readonly label: string;
  readonly used: number;
  readonly reserved: number;
  readonly total: number;
  readonly valueLabel: string;
  readonly valueText: string;
  readonly hint: string;
}) {
  const pct = (n: number) => `${total > 0 ? Math.min(100, Math.max(0, (n / total) * 100)) : 0}%`;
  const usedPct = pct(used);
  // stand-in until AURA #89 (Progress reserved segment): AURA's markup by hand
  return (
    <div className="aura-progress">
      <div className="aura-progress__head">
        <span className="aura-progress__label">{label}</span>
        <span className="aura-progress__value">{valueLabel}</span>
      </div>
      <div
        className="aura-progress__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={used}
        aria-valuetext={valueText}
      >
        {/* stand-in until AURA #89: the used and reserved bars */}
        <span className="aura-progress__bar" style={{ width: usedPct }} />
        <span
          className="aura-progress__bar rounded-none opacity-60"
          style={{
            left: usedPct,
            width: pct(Math.min(reserved, total - used)),
            background: 'repeating-linear-gradient(45deg, var(--aura-fg-accent) 0 3px, transparent 3px 6px)',
          }}
        />
      </div>
      <p className="aura-progress__hint">{hint}</p>
    </div>
  );
}
