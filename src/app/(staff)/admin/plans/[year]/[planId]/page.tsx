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
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PencilIcon } from 'lucide-react';
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
          <div className="flex gap-2">
            <Badge variant={plan.plan_category === 'partnership' ? 'default' : 'secondary'}>
              {t(`badges.${plan.plan_category}`)}
            </Badge>
            {plan.deleted_at ? (
              <Badge variant="outline">{t('badges.deleted')}</Badge>
            ) : plan.is_active ? (
              <Badge variant="default">{t('badges.active')}</Badge>
            ) : (
              <Badge variant="secondary">{t('badges.inactive')}</Badge>
            )}
          </div>
        }
        actions={
          canWritePlans ? (
            <>
              {!isDeleted ? (
                <Link
                  href={`/admin/plans/${plan.plan_year}/${plan.plan_id}/edit`}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  <PencilIcon className="h-3.5 w-3.5" aria-hidden="true" />
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

      <Card>
        <CardHeader>
          <CardTitle>{t('create.labels.annualFee')}</CardTitle>
          <CardDescription>
            {t('columns.year')}: {plan.plan_year}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('create.labels.annualFee')}
              </dt>
              <dd className="text-lg font-semibold">
                <MoneyDisplay
                  amountMinorUnits={plan.annual_fee_minor_units}
                  currencyCode={currencyCode}
                />
              </dd>
            </div>
            {vat ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {tDetail('totalWithVat')}
                </dt>
                <dd className="text-lg font-semibold">
                  <PlanFeeWithVat
                    feeMinorUnits={plan.annual_fee_minor_units}
                    totalWithVatMinorUnits={vat.totalMinorUnits}
                    vatRatePercent={vat.ratePercent}
                    currencyCode={currencyCode}
                  />
                </dd>
              </div>
            ) : null}
            {memberCount !== null ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {tDetail('members')}
                </dt>
                <dd className="text-lg font-semibold">
                  {canPerform(currentUser.role, 'members.read') ? (
                    <Link
                      href={`/admin/members?plan_id=${encodeURIComponent(plan.plan_id)}`}
                      className="underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {tDetail('memberCount', { count: memberCount })}
                    </Link>
                  ) : (
                    tDetail('memberCount', { count: memberCount })
                  )}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('create.labels.memberTypeScope')}
              </dt>
              <dd className="text-lg font-semibold">
                {tOptions(`memberTypeScope.${plan.member_type_scope}`)}
              </dd>
            </div>
            {plan.includes_corporate_plan_id ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('create.labels.includesCorporatePlanId')}
                </dt>
                <dd className="text-lg font-semibold">{bundledPlanName ?? plan.includes_corporate_plan_id}</dd>
              </div>
            ) : null}
            {plan.min_turnover_minor_units !== null ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('create.labels.minTurnover')}
                </dt>
                <dd className="text-lg font-semibold">
                  <MoneyDisplay
                    amountMinorUnits={plan.min_turnover_minor_units}
                    currencyCode={currencyCode}
                  />
                </dd>
              </div>
            ) : null}
            {plan.max_turnover_minor_units !== null ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('create.labels.maxTurnover')}
                </dt>
                <dd className="text-lg font-semibold">
                  <MoneyDisplay
                    amountMinorUnits={plan.max_turnover_minor_units}
                    currencyCode={currencyCode}
                  />
                </dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('create.labels.benefitMatrix')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <section>
            <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              {tM('section.brandVisibility')}
            </h2>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
              <KV label={tM('eblastPerYear')} value={String(plan.benefit_matrix.eblast_per_year)} raw />
              <KV
                label={tM('websitePageType')}
                value={
                  plan.benefit_matrix.website_page_type
                    ? tOptions(
                        `websitePageType.${plan.benefit_matrix.website_page_type}`,
                      )
                    : '—'
                }
              />
              <KV
                label={tM('homepageLogo')}
                value={
                  plan.benefit_matrix.homepage_logo_category
                    ? tOptions(
                        `homepageLogoCategory.${plan.benefit_matrix.homepage_logo_category}`,
                      )
                    : '—'
                }
              />
              <KV
                label={tM('directoryListing')}
                value={
                  plan.benefit_matrix.directory_listing_size
                    ? tOptions(
                        `directoryListingSize.${plan.benefit_matrix.directory_listing_size}`,
                      )
                    : '—'
                }
              />
            </dl>
          </section>
          <Separator />
          <section>
            <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              {tM('section.events')}
            </h2>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
              <KV
                label={tM('discountScope')}
                value={tOptions(
                  `eventDiscountScope.${plan.benefit_matrix.event_discount_scope}`,
                )}
              />
              <KV
                label={tM('coBrandedAccess')}
                value={tCommon(
                  plan.benefit_matrix.events_cobranded_access ? 'yes' : 'no',
                )}
                raw
              />
              <KV
                label={tM('culturalTicketsYear')}
                value={String(plan.benefit_matrix.cultural_tickets_per_year)}
                raw
              />
            </dl>
          </section>
          <Separator />
          <section>
            <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              {tM('section.additionalBenefits')}
            </h2>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
              <KV
                label={tM('m2mBenefitsAccess')}
                value={tCommon(plan.benefit_matrix.m2m_benefits_access ? 'yes' : 'no')}
              />
              <KV
                label={tM('businessReferrals')}
                value={tCommon(plan.benefit_matrix.business_referrals ? 'yes' : 'no')}
              />
              <KV
                label={tM('tailorMadeServices')}
                value={tCommon(plan.benefit_matrix.tailor_made_services ? 'yes' : 'no')}
              />
            </dl>
          </section>
          {plan.benefit_matrix.partnership ? (
            <>
              <Separator />
              <section>
                <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  {tM('section.partnershipBenefits')}
                </h2>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
                  <KV
                    label={tM('eventTickets')}
                    value={String(plan.benefit_matrix.partnership.event_tickets_included)}
                    raw
                  />
                  <KV
                    label={tM('videoDurationShort')}
                    value={tOptions(
                      plan.benefit_matrix.partnership.video_duration_minutes === 1.5
                        ? 'videoDuration.1_5'
                        : 'videoDuration.1_0',
                    )}
                  />
                  <KV
                    label={tM('videoFrequencyScope')}
                    value={tOptions(
                      `videoFrequencyScope.${plan.benefit_matrix.partnership.video_frequency_scope}`,
                    )}
                  />
                  <KV
                    label={tM('websiteLogoMonths')}
                    value={String(plan.benefit_matrix.partnership.website_logo_months)}
                    raw
                  />
                  <KV
                    label={tM('bannerPerYear')}
                    value={String(plan.benefit_matrix.partnership.banner_per_year)}
                    raw
                  />
                  <KV
                    label={tM('directoryAd')}
                    value={tOptions(
                      `directoryAdPosition.${plan.benefit_matrix.partnership.directory_ad_position}`,
                    )}
                  />
                  <KV
                    label={tM('boothIncluded')}
                    value={tCommon(plan.benefit_matrix.partnership.booth_included ? 'yes' : 'no')}
                  />
                  <KV
                    label={tM('rollupLogoAtEvents')}
                    value={tCommon(
                      plan.benefit_matrix.partnership.rollup_logo_at_events ? 'yes' : 'no',
                    )}
                  />
                  <KV
                    label={tM('logoOnMerch')}
                    value={tCommon(plan.benefit_matrix.partnership.logo_on_merch ? 'yes' : 'no')}
                  />
                  <KV
                    label={tM('newsletterPromotion')}
                    value={tCommon(
                      plan.benefit_matrix.partnership.newsletter_promotion ? 'yes' : 'no',
                    )}
                  />
                  <KV
                    label={tM('eNewsletterLogo')}
                    value={tCommon(plan.benefit_matrix.partnership.enewsletter_logo ? 'yes' : 'no')}
                  />
                </dl>
              </section>
            </>
          ) : null}
        </CardContent>
      </Card>
    </DetailContainer>
  );
}

// `value` is always a final display string — numbers are stringified at the
// call site and enum values are localized via `tOptions(...)`. (The former
// `humanize()` fallback produced English-only Title-Case for enum slugs, which
// broke TH/SV — removed; `raw` is kept as an accepted no-op for the existing
// call sites that already passed pre-formatted strings.)
function KV({ label, value }: { label: string; value: string; raw?: boolean }) {
  return (
    <div className="flex justify-between border-b border-border/50 py-1 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
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
