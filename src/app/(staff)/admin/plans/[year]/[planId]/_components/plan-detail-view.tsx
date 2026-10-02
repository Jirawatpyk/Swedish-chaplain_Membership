/**
 * 122 US6 (T603, T609) — the plan detail page's view, shared by the page
 * and the no-DB preview route (`/test-fixtures/aura-admin?view=plan`), so
 * the screenshots show the page itself, never a copy of its layout.
 * Board `Admin-plan-detail` (+ `-mobile`): the category badge and status
 * pill beside the title, Edit and a "More actions" menu, then the fee and
 * the benefit matrix as two cards side by side (stacked on a phone), each a
 * list of label / value rows.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { PencilIcon } from 'lucide-react';
import { Badge, Card, Icon, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { formatCalendarYear } from '@/lib/format-date-localised';
import type { Plan } from '@/modules/plans';
import { MoneyDisplay } from '@/components/plans/money-display';
import { LocaleTextDisplay } from '@/components/plans/locale-text-display';
import { PlanDetailActions } from '@/components/plans/plan-detail-actions';
import { PlanFeeWithVat } from '@/components/plans/plan-fee-with-vat';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';

export interface PlanDetailViewProps {
  readonly plan: Plan;
  /** The route's own segments, for the breadcrumb labels. */
  readonly year: string;
  readonly planId: string;
  readonly canWritePlans: boolean;
  readonly canReadMembers: boolean;
  readonly currencyCode: string;
  /** The VAT-inclusive total and rate; `null` when the tax policy is unknown. */
  readonly vat: { readonly totalMinorUnits: number; readonly ratePercent: number } | null;
  /** Members on the plan; `null` hides the row (a failed count). */
  readonly memberCount: number | null;
  readonly bundledPlanName: string | null;
}

export async function renderPlanDetailView({
  plan,
  year,
  planId,
  canWritePlans,
  canReadMembers,
  currencyCode,
  vat,
  memberCount,
  bundledPlanName,
}: PlanDetailViewProps) {
  const t = await getTranslations('admin.plans');
  const locale = await getLocale();
  const tM = await getTranslations('admin.plans.create.matrix');
  const tOptions = await getTranslations('admin.plans.create.options');
  const tCommon = await getTranslations('common');
  const tDetail = await getTranslations('admin.plans.detail');
  const isDeleted = plan.deleted_at !== null;
  const planDisplayName = plan.plan_name.en ?? planId;

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={year} label={String(plan.plan_year)} />
      <PlanBreadcrumbLabel segment={planId} label={planDisplayName} />
      <PageHeader
        title={
          <LocaleTextDisplay
            value={plan.plan_name}
            // 016 re-review D — the badge is a write-side affordance (it
            // prompts fixing the missing locale), so it follows 'plans.write'.
            showMissingBadge={canWritePlans}
          />
        }
        subtitle={
          plan.description ? <LocaleTextDisplay value={plan.description} /> : undefined
        }
        badge={
          <div className="flex items-center gap-2">
            <Badge tone={plan.plan_category === 'partnership' ? 'accent' : 'neutral'}>
              {t(`badges.${plan.plan_category}`)}
            </Badge>
            {plan.deleted_at ? (
              <StatusPill tone="blocked">{t('badges.deleted')}</StatusPill>
            ) : plan.is_active ? (
              <StatusPill tone="ready">{t('badges.active')}</StatusPill>
            ) : (
              <StatusPill tone="neutral">{t('badges.inactive')}</StatusPill>
            )}
          </div>
        }
        actions={
          canWritePlans ? (
            <>
              {!isDeleted ? (
                <Link
                  href={`/admin/plans/${plan.plan_year}/${plan.plan_id}/edit`}
                  className={buttonClass({ variant: 'secondary' })}
                >
                  <PencilIcon className="size-4" aria-hidden="true" />
                  {t('actions.edit')}
                </Link>
              ) : null}
              <PlanDetailActions
                plan={{
                  plan_id: plan.plan_id,
                  plan_year: plan.plan_year,
                  plan_name: plan.plan_name,
                  is_active: plan.is_active,
                  deleted_at: plan.deleted_at ? plan.deleted_at.toISOString() : null,
                }}
              />
            </>
          ) : undefined
        }
      />

      <div className="grid items-start gap-[var(--aura-space-4)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card
          title={t('create.labels.annualFee')}
          description={tDetail('yearLine', { year: formatCalendarYear(plan.plan_year, locale) })}
          headingLevel={2}
        >
          <dl>
            <KV label={t('create.labels.annualFee')}>
              {vat ? (
                <PlanFeeWithVat
                  feeMinorUnits={plan.annual_fee_minor_units}
                  totalWithVatMinorUnits={vat.totalMinorUnits}
                  vatRatePercent={vat.ratePercent}
                  currencyCode={currencyCode}
                />
              ) : (
                <MoneyDisplay
                  amountMinorUnits={plan.annual_fee_minor_units}
                  currencyCode={currencyCode}
                  className="font-semibold"
                />
              )}
            </KV>
            <KV label={t('create.labels.memberTypeScope')}>
              {tOptions(`memberTypeScope.${plan.member_type_scope}`)}
            </KV>
            {plan.includes_corporate_plan_id ? (
              <KV label={t('create.labels.includesCorporatePlanId')}>
                {bundledPlanName ?? plan.includes_corporate_plan_id}
              </KV>
            ) : null}
            {plan.min_turnover_minor_units !== null ? (
              <KV label={t('create.labels.minTurnover')}>
                <MoneyDisplay
                  amountMinorUnits={plan.min_turnover_minor_units}
                  currencyCode={currencyCode}
                />
              </KV>
            ) : null}
            {plan.max_turnover_minor_units !== null ? (
              <KV label={t('create.labels.maxTurnover')}>
                <MoneyDisplay
                  amountMinorUnits={plan.max_turnover_minor_units}
                  currencyCode={currencyCode}
                />
              </KV>
            ) : null}
            {memberCount !== null ? (
              <KV label={tDetail('members')}>
                {canReadMembers ? (
                  <Link
                    // With the year: the count is per (plan, year) and
                    // un-renewed members stay on older years' plan rows.
                    href={`/admin/members?plan_id=${encodeURIComponent(plan.plan_id)}&plan_year=${plan.plan_year}`}
                    className="text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
                  >
                    {tDetail('memberCount', { count: memberCount })}
                  </Link>
                ) : (
                  tDetail('memberCount', { count: memberCount })
                )}
              </KV>
            ) : null}
          </dl>
        </Card>

        <Card title={t('create.labels.benefitMatrix')} headingLevel={2}>
          <KVGroup title={tM('section.brandVisibility')}>
            <KV label={tM('eblastPerYear')}>{String(plan.benefit_matrix.eblast_per_year)}</KV>
            <KV label={tM('websitePageType')}>
              {plan.benefit_matrix.website_page_type
                ? tOptions(`websitePageType.${plan.benefit_matrix.website_page_type}`)
                : '—'}
            </KV>
            <KV label={tM('homepageLogo')}>
              {plan.benefit_matrix.homepage_logo_category
                ? tOptions(`homepageLogoCategory.${plan.benefit_matrix.homepage_logo_category}`)
                : '—'}
            </KV>
            <KV label={tM('directoryListing')}>
              {plan.benefit_matrix.directory_listing_size
                ? tOptions(`directoryListingSize.${plan.benefit_matrix.directory_listing_size}`)
                : '—'}
            </KV>
          </KVGroup>
          <KVGroup title={tM('section.events')}>
            <KV label={tM('discountScope')}>
              {tOptions(`eventDiscountScope.${plan.benefit_matrix.event_discount_scope}`)}
            </KV>
            <KV label={tM('coBrandedAccess')}>
              <YesNo value={plan.benefit_matrix.events_cobranded_access} yes={tCommon('yes')} no={tCommon('no')} />
            </KV>
            <KV label={tM('culturalTicketsYear')}>
              {String(plan.benefit_matrix.cultural_tickets_per_year)}
            </KV>
          </KVGroup>
          <KVGroup title={tM('section.additionalBenefits')}>
            <KV label={tM('m2mBenefitsAccess')}>
              <YesNo value={plan.benefit_matrix.m2m_benefits_access} yes={tCommon('yes')} no={tCommon('no')} />
            </KV>
            <KV label={tM('businessReferrals')}>
              <YesNo value={plan.benefit_matrix.business_referrals} yes={tCommon('yes')} no={tCommon('no')} />
            </KV>
            <KV label={tM('tailorMadeServices')}>
              <YesNo value={plan.benefit_matrix.tailor_made_services} yes={tCommon('yes')} no={tCommon('no')} />
            </KV>
          </KVGroup>
          {plan.benefit_matrix.partnership ? (
            <KVGroup title={tM('section.partnershipBenefits')}>
              <KV label={tM('eventTickets')}>
                {String(plan.benefit_matrix.partnership.event_tickets_included)}
              </KV>
              <KV label={tM('videoDurationShort')}>
                {tOptions(
                  plan.benefit_matrix.partnership.video_duration_minutes === 1.5
                    ? 'videoDuration.1_5'
                    : 'videoDuration.1_0',
                )}
              </KV>
              <KV label={tM('videoFrequencyScope')}>
                {tOptions(`videoFrequencyScope.${plan.benefit_matrix.partnership.video_frequency_scope}`)}
              </KV>
              <KV label={tM('websiteLogoMonths')}>
                {String(plan.benefit_matrix.partnership.website_logo_months)}
              </KV>
              <KV label={tM('bannerPerYear')}>
                {String(plan.benefit_matrix.partnership.banner_per_year)}
              </KV>
              <KV label={tM('directoryAd')}>
                {tOptions(`directoryAdPosition.${plan.benefit_matrix.partnership.directory_ad_position}`)}
              </KV>
              <KV label={tM('boothIncluded')}>
                <YesNo value={plan.benefit_matrix.partnership.booth_included} yes={tCommon('yes')} no={tCommon('no')} />
              </KV>
              <KV label={tM('rollupLogoAtEvents')}>
                <YesNo value={plan.benefit_matrix.partnership.rollup_logo_at_events} yes={tCommon('yes')} no={tCommon('no')} />
              </KV>
              <KV label={tM('logoOnMerch')}>
                <YesNo value={plan.benefit_matrix.partnership.logo_on_merch} yes={tCommon('yes')} no={tCommon('no')} />
              </KV>
              <KV label={tM('newsletterPromotion')}>
                <YesNo value={plan.benefit_matrix.partnership.newsletter_promotion} yes={tCommon('yes')} no={tCommon('no')} />
              </KV>
              <KV label={tM('eNewsletterLogo')}>
                <YesNo value={plan.benefit_matrix.partnership.enewsletter_logo} yes={tCommon('yes')} no={tCommon('no')} />
              </KV>
            </KVGroup>
          ) : null}
        </Card>
      </div>
    </DetailContainer>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-[var(--aura-space-4)] border-t border-[var(--aura-border-subtle)] py-[var(--aura-space-3)] sm:grid sm:grid-cols-[220px_1fr] sm:justify-normal">
      <dt className="text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="text-end sm:text-start">{children}</dd>
    </div>
  );
}

/** A group of rows under a small mono heading (Brand Visibility, Events, …). */
function KVGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="not-first:mt-[var(--aura-space-4)]">
      <h3 className="aura-text-mono pb-[var(--aura-space-2)] uppercase tracking-wider text-[var(--aura-fg-secondary)]">
        {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

/** "Yes" with AURA's check, as the board draws a benefit that is on; "No" plain. */
function YesNo({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  return value ? (
    <span className="inline-flex items-center gap-[var(--aura-space-1)]">
      <Icon name="check" />
      {yes}
    </span>
  ) : (
    <>{no}</>
  );
}
