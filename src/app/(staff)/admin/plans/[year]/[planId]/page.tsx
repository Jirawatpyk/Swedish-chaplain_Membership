/**
 * T087 — /admin/plans/[year]/[planId] detail page (US1).
 *
 * Read-only plan detail view showing full benefit matrix grouped by
 * category (Brand Visibility / Events / Additional / Partnership).
 * Server component — loads via `getPlan` use case, 404s via
 * `notFound()` when the plan doesn't exist (or belongs to another
 * tenant — RLS handles that case transparently).
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';
import { asPlanSlug, asPlanYear, getPlan } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { MoneyDisplay } from '@/components/plans/money-display';
import { LocaleTextDisplay } from '@/components/plans/locale-text-display';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}): Promise<Metadata> {
  const { planId } = await params;
  return { title: `${planId} · Plans · SweCham` };
}

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}) {
  const { user: currentUser } = await requireSession('staff');
  const { year, planId } = await params;
  const t = await getTranslations('admin.plans');

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

  // Load fee config for currency code — via the composition root so
  // we respect the module boundary (no deep import into infrastructure).
  const feeConfig = await deps.feeConfigRepo.findByTenant(tenant);
  const currencyCode = feeConfig?.currency_code ?? 'THB';

  const planDisplayName = plan.plan_name.en ?? planId;

  return (
    <ContentContainer>
      <PlanBreadcrumbLabel segment={planId} label={planDisplayName} />
      <PageHeader
        title={
          <LocaleTextDisplay
            value={plan.plan_name}
            showMissingBadge={currentUser.role === 'admin'}
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
            <div>
              <dt className="text-xs font-medium uppercase text-muted-foreground">
                {t('create.labels.memberTypeScope')}
              </dt>
              <dd className="text-lg font-semibold capitalize">{plan.member_type_scope}</dd>
            </div>
            {plan.includes_corporate_plan_id ? (
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">
                  {t('create.labels.includesCorporatePlanId')}
                </dt>
                <dd className="text-lg font-semibold">{plan.includes_corporate_plan_id}</dd>
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
              Brand Visibility
            </h2>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
              <KV label="E-blast per year" value={String(plan.benefit_matrix.eblast_per_year)} />
              <KV
                label="Website page type"
                value={plan.benefit_matrix.website_page_type ?? '—'}
              />
              <KV
                label="Homepage logo"
                value={plan.benefit_matrix.homepage_logo_category ?? '—'}
              />
              <KV
                label="Directory listing"
                value={plan.benefit_matrix.directory_listing_size ?? '—'}
              />
            </dl>
          </section>
          <Separator />
          <section>
            <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
              Events
            </h2>
            <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
              <KV label="Discount scope" value={plan.benefit_matrix.event_discount_scope} />
              <KV
                label="Co-branded access"
                value={plan.benefit_matrix.events_cobranded_access ? 'Yes' : 'No'}
              />
              <KV
                label="Cultural tickets/year"
                value={String(plan.benefit_matrix.cultural_tickets_per_year)}
              />
            </dl>
          </section>
          {plan.benefit_matrix.partnership ? (
            <>
              <Separator />
              <section>
                <h2 className="text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                  Partnership
                </h2>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-body md:grid-cols-2">
                  <KV
                    label="Event tickets"
                    value={String(plan.benefit_matrix.partnership.event_tickets_included)}
                  />
                  <KV
                    label="Video duration"
                    value={`${plan.benefit_matrix.partnership.video_duration_minutes} min`}
                  />
                  <KV
                    label="Website logo months"
                    value={String(plan.benefit_matrix.partnership.website_logo_months)}
                  />
                  <KV
                    label="Banner per year"
                    value={String(plan.benefit_matrix.partnership.banner_per_year)}
                  />
                  <KV
                    label="Directory ad"
                    value={plan.benefit_matrix.partnership.directory_ad_position}
                  />
                </dl>
              </section>
            </>
          ) : null}
        </CardContent>
      </Card>
    </ContentContainer>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-border/50 py-1 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
