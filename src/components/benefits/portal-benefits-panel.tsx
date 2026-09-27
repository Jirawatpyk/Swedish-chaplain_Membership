'use client';

/**
 * Spec 122 US3 — the member Benefits tab as the portal `Benefits` /
 * `Benefits-mobile` boards draw it: a page-level "Benefit usage · {year}"
 * heading with the freshness note, one AURA card per tracked benefit (the
 * big used figure, a bar with its last use as the hint, the next step as a
 * secondary button), then an "Included benefits" card listing the plan's
 * unmetered benefits with a check chip each.
 *
 * Member-portal only; the admin benefit screens keep `BenefitUsageCard`. The
 * under-use warning (FR-021) stays, above the heading. Reserved E-Blasts and
 * each included benefit's detail line ("1 page + logo") need data the usage
 * read does not carry yet, so they are not drawn.
 */
import Link from 'next/link';
import { CalendarDays, Check, Mail, PackageOpen, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Progress } from '@jirawatpyk/aura-react';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatCalendarYear, getDateFormatLocale } from '@/lib/format-date-localised';
import { cn } from '@/lib/utils';
import type { BenefitUsageItem } from './benefit-usage-card';
import { UnderUseWarning } from './under-use-warning';

const ACTION_ICON: Readonly<Record<string, LucideIcon>> = {
  eblast: Mail,
  cultural_tickets: CalendarDays,
};

export interface PortalBenefitsPanelProps {
  readonly locale: string;
  readonly membershipYear: number;
  readonly elapsedYearPct: number;
  readonly quantifiable: readonly BenefitUsageItem[];
  readonly active: ReadonlyArray<{ readonly key: string }>;
  readonly aggregateConsumedPct: number | null;
  readonly underUseWarning: boolean;
  readonly warningActionHref?: string | undefined;
  /** The plan's display name for "Part of your {plan} plan for {year}"; null when it did not resolve. */
  readonly planName: string | null;
}

export function PortalBenefitsPanel({
  locale,
  membershipYear,
  elapsedYearPct,
  quantifiable,
  active,
  aggregateConsumedPct,
  underUseWarning,
  warningActionHref,
  planName,
}: PortalBenefitsPanelProps): React.ReactElement {
  const t = useTranslations('benefits');
  const year = formatCalendarYear(membershipYear, locale);
  // `timeZone` pinned — the server and a Bangkok browser must agree on the day.
  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat(getDateFormatLocale(locale), { dateStyle: 'medium', timeZone: 'Asia/Bangkok' }).format(
      new Date(iso),
    );

  if (quantifiable.length === 0 && active.length === 0) {
    return (
      <div className="aura-empty" data-testid="benefit-usage-card">
        <span className="aura-empty__icon" aria-hidden>
          <PackageOpen className="size-6" />
        </span>
        <p className="aura-empty__title">{t('card.emptyTitle')}</p>
        <p className="aura-empty__text">{t('card.empty')}</p>
      </div>
    );
  }

  return (
    <section data-testid="benefit-usage-card" aria-labelledby="benefits-panel-heading" className="flex flex-col gap-6">
      {underUseWarning && aggregateConsumedPct !== null ? (
        <UnderUseWarning
          elapsedYearPct={elapsedYearPct}
          consumedPct={aggregateConsumedPct}
          {...(warningActionHref !== undefined ? { actionHref: warningActionHref } : {})}
        />
      ) : null}

      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 id="benefits-panel-heading" className="text-h2" style={{ lineHeight: 1.3 }}>
          {t('card.title', { year })}
        </h2>
        <span className="text-xs text-[var(--aura-fg-secondary)]">{t('card.liveNote')}</span>
      </div>

      {quantifiable.length > 0 ? (
        <ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-6">
          {quantifiable.map((b) => {
            const Icon = ACTION_ICON[b.key];
            const name = t(`benefit.${b.key}`);
            return (
              <li key={b.key} className="flex">
                <Card title={name} description={t(`benefit.description.${b.key}`)} headingLevel={3} className="w-full">
                  <div className="flex flex-col gap-5">
                    <p className="flex items-baseline gap-2">
                      <span className="text-[26px] leading-[1.2] font-semibold tabular-nums sm:text-[28px]">{b.used}</span>
                      <span className="text-sm text-[var(--aura-fg-secondary)]">{t('card.ofTotalUsed', { total: b.entitlement })}</span>
                    </p>
                    <Progress
                      aria-label={t('card.benefitUsed', { benefit: name })}
                      value={b.used}
                      max={b.entitlement}
                      valueLabel={t('card.usedOf', { used: b.used, total: b.entitlement })}
                      hint={b.lastUsedAt === null ? t('card.neverUsed') : t('card.lastUsed', { date: formatDate(b.lastUsedAt) })}
                    />
                    {b.actionHref !== undefined ? (
                      <Link
                        href={b.actionHref}
                        className={cn(buttonClass({ variant: 'secondary' }), 'no-underline max-sm:w-full sm:self-start')}
                      >
                        {Icon ? <Icon className="aura-icon size-4" aria-hidden /> : null}
                        {t(`benefit.action.${b.key}`)}
                      </Link>
                    ) : null}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : null}

      {active.length > 0 ? (
        <Card
          title={t('card.activeHeading')}
          description={
            planName !== null
              ? t('card.activeDescriptionPlan', { plan: planName, year })
              : t('card.activeDescription', { year })
          }
          headingLevel={2}
        >
          <ul className="grid grid-cols-1 lg:grid-cols-2 lg:gap-x-8">
            {active.map((a) => (
              <li key={a.key} className="flex items-start gap-3 border-t border-[var(--aura-border-default)] py-3">
                <span
                  aria-hidden
                  className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--aura-bg-selected)] text-[var(--aura-fg-accent)]"
                >
                  <Check className="size-4" />
                </span>
                <span className="self-center text-[13px] font-medium">{t(`active.${a.key}`)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </section>
  );
}
