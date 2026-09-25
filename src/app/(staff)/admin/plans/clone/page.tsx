/**
 * T110 — /admin/plans/clone page (US2).
 *
 * Server component that loads the list of plans for the source year
 * (so the confirmation dialog can accurately quote the row count), then
 * hands off to the client `<CloneYearClient>` shell for source/target
 * pickers + the CloneYearDialog confirmation.
 *
 * Source/target default to the current year → next year. `?from=` /
 * `?to=` (sent by the prior-year lock banner) override them when valid.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CloneYearClient } from './clone-year-client';
import { parseCloneYearParam } from './clone-year-params';

interface SearchParams {
  readonly from?: string | string[];
  readonly to?: string | string[];
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.plans.clone');
  return { title: t('title') };
}

export default async function CloneYearPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requirePagePermission('plans.clone');
  const query = await searchParams;

  const t = await getTranslations('admin.plans.clone');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const currentYear = deps.clock.currentYear();
  const sourceYear = parseCloneYearParam(query.from) ?? currentYear;
  const targetYear = parseCloneYearParam(query.to) ?? currentYear + 1;

  // Load the default source year's catalogue so we can seed the
  // confirmation dialog with an accurate row count.
  const listResult = await listPlans(
    { filter: { year: asPlanYear(sourceYear) } },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      taxPolicy: deps.taxPolicy,
      clock: deps.clock,
    },
  );
  const sourcePlans = listResult.ok
    ? listResult.value.data.map((p) => ({
        plan_id: p.plan_id,
        plan_name: p.plan_name,
        annual_fee_minor_units: p.annual_fee_minor_units,
        is_active: p.is_active,
      }))
    : [];
  const currencyCode = listResult.ok ? listResult.value.meta.currency_code : 'THB';

  return (
    <FormContainer>
      <PageHeader title={t('title')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CloneYearClient
            defaultSourceYear={sourceYear}
            defaultTargetYear={targetYear}
            currencyCode={currencyCode}
            defaultSourcePlans={sourcePlans}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
