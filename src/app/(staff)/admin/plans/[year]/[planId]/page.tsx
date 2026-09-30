/**
 * T087 — /admin/plans/[year]/[planId] detail page (US1).
 *
 * Plan detail view: fee (with the VAT-inclusive total), eligibility,
 * the number of members on the plan, and the full benefit matrix grouped
 * by category (Brand Visibility / Events / Additional / Partnership).
 * `plans.write` holders also get Edit + the actions menu (Activate /
 * Deactivate, Delete, Restore) in the header.
 * Server component — loads via `getPlan` use case, 404s via
 * `notFound()` when the plan doesn't exist (or belongs to another
 * tenant — RLS handles that case transparently).
 *
 * 122 US6 (T603): on AURA as the `Admin-plan-detail` board draws it — the
 * category badge and status pill beside the title, Edit and a "More actions"
 * menu, then the fee and the benefit matrix as two cards side by side
 * (stacked on a phone), each a list of label / value rows.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatCalendarYear } from '@/lib/format-date-localised';
import { PencilIcon } from 'lucide-react';
import { Badge, Card, Icon, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';
import {
  asPlanSlug,
  asPlanYear,
  getPlan,
  grossWithVatMinorUnits,
  vatRatePercent,
} from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { MoneyDisplay } from '@/components/plans/money-display';
import { LocaleTextDisplay } from '@/components/plans/locale-text-display';
import { PlanDetailActions } from '@/components/plans/plan-detail-actions';
import { PlanFeeWithVat } from '@/components/plans/plan-fee-with-vat';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}): Promise<Metadata> {
  const { year, planId } = await params;
  const yearNum = Number(year);
  const tPlans = await getTranslations('admin.plans');
  if (!Number.isInteger(yearNum) || !/^[a-z0-9-]{1,63}$/.test(planId)) {
    // Invalid url params (uuid/year format mismatch) — page itself
    // notFound()s; metadata just falls back to the list-page title.
    return { title: tPlans('title') };
  }
  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const plan = await deps.planRepo.findOne(
    tenant,
    asPlanSlug(planId),
    asPlanYear(yearNum),
  );
  const displayName = plan?.plan_name.en ?? planId;
  // Layout template appends "· SweCham Membership" automatically.
  return { title: `${displayName} · ${tPlans('title')}` };
}

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}) {
  const { user: currentUser } = await requirePagePermission('plans.read');
  const { year, planId } = await params;
  const t = await getTranslations('admin.plans');
  const locale = await getLocale();
  const tM = await getTranslations('admin.plans.create.matrix');
  const tOptions = await getTranslations('admin.plans.create.options');
  const tCommon = await getTranslations('common');
  const tDetail = await getTranslations('admin.plans.detail');

  const yearNumber = Number(year);
  if (!Number.isInteger(yearNumber) || yearNumber < 2000 || yearNumber > 2100) {
    notFound();
  }
  if (!/^[a-z0-9-]{1,63}$/.test(planId)) {
    notFound();
  }

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const requestId = requestIdFromHeaders(await headers());
  void REQUEST_ID_HEADER; // re-export touchpoint for future telemetry

  const result = await getPlan(
    { planId: asPlanSlug(planId), year: asPlanYear(yearNumber) },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      audit: deps.audit,
      actorUserId: currentUser.id,
      requestId,
      sourceIp: null,
      method: 'GET',
      route: `/admin/plans/${year}/${planId}`,
    },
  );

  if (!result.ok) notFound();
  const plan = result.value;

  // R8 — currency via F4 invoice_settings taxPolicy (consolidated).
  const taxPolicy = await deps.taxPolicy();
  const currencyCode = taxPolicy?.currencyCode ?? 'THB';
  const vat = taxPolicy ? vatSummary(plan.annual_fee_minor_units, taxPolicy.vatRateRaw) : null;

  // Active + inactive members on this (plan, year) — the FR-010 count the
  // delete guard uses. A failed count hides the row rather than the page.
  const memberCount = await deps.members
    .countActivePlanMembers(tenant, asPlanSlug(plan.plan_id), asPlanYear(plan.plan_year))
    .catch(() => null);

  const canWritePlans = canPerform(currentUser.role, 'plans.write');
  const isDeleted = plan.deleted_at !== null;

  const planDisplayName = plan.plan_name.en ?? planId;

  // Resolve includes_corporate_plan_id slug → display name
  let bundledPlanName: string | null = null;
  if (plan.includes_corporate_plan_id) {
    const linked = await deps.planRepo.findOne(
      tenant,
      asPlanSlug(plan.includes_corporate_plan_id),
      asPlanYear(plan.plan_year),
    );
    bundledPlanName = linked?.plan_name.en ?? null;
  }

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

      <div className="grid items-start gap-[var(--aura-space-4)] lg:grid-cols-[1fr_1.4fr]">
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
                {canPerform(currentUser.role, 'members.read') ? (
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

/**
 * One label / value row, ruled above as the board draws it: a 220px label
 * column from 640px, the value on the right of the same line on a phone.
 * Every value is already a display string or node (enum values go through
 * `tOptions`, numbers are stringified at the call site).
 */
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

// VAT-inclusive total + the rate as a percentage, via the same integer math
// the plans list uses. A tax-policy rate the domain rejects hides the row
// instead of failing the page.
function vatSummary(
  feeMinorUnits: number,
  vatRateRaw: string,
): { readonly totalMinorUnits: number; readonly ratePercent: number } | null {
  try {
    return {
      totalMinorUnits: grossWithVatMinorUnits(feeMinorUnits, vatRateRaw),
      ratePercent: vatRatePercent(vatRateRaw),
    };
  } catch {
    return null;
  }
}
