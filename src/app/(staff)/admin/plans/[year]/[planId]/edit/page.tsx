/**
 * T121 — /admin/plans/[year]/[planId]/edit (US3).
 *
 * Admin-only edit page. Loads the plan via `getPlan` (RLS-scoped),
 * resolves the tenant fee config for the currency prefix, computes
 * the current year for the prior-year-lock rule, and hands off to
 * the client `<EditPlanClient>` shell for form state + submission.
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asPlanSlug, asPlanYear, getPlan, type PlanSchemaInput } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout/form-container';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { EditPlanClient } from './edit-plan-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Edit plan · SweCham' };
}

export default async function EditPlanPage({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}) {
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') {
    redirect('/admin/plans');
  }

  const { year: rawYear, planId: rawPlanId } = await params;
  const year = Number.parseInt(rawYear, 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    notFound();
  }
  if (!/^[a-z0-9-]{1,63}$/.test(rawPlanId)) {
    notFound();
  }

  const t = await getTranslations('admin.plans.edit');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const requestId = requestIdFromHeaders(await headers());

  const planResult = await getPlan(
    {
      planId: asPlanSlug(rawPlanId),
      year: asPlanYear(year),
    },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      audit: deps.audit,
      actorUserId: currentUser.id,
      requestId,
      sourceIp: null,
      method: 'GET',
      route: `/admin/plans/${year}/${rawPlanId}/edit`,
    },
  );

  if (!planResult.ok) {
    notFound();
  }

  const plan = planResult.value;
  const feeConfig = await deps.feeConfigRepo.findByTenant(deps.tenant);
  const currentYear = deps.clock.currentYear();
  const currencyPrefix =
    feeConfig?.currency_code === 'THB' ? '฿' : (feeConfig?.currency_code ?? 'THB');

  // Convert the Domain Plan to a PlanSchemaInput-shaped initial value
  const initialValues: PlanSchemaInput = {
    plan_id: plan.plan_id,
    plan_year: plan.plan_year,
    plan_name: plan.plan_name,
    description: plan.description,
    sort_order: plan.sort_order,
    plan_category: plan.plan_category,
    member_type_scope: plan.member_type_scope,
    annual_fee_minor_units: plan.annual_fee_minor_units,
    includes_corporate_plan_id: plan.includes_corporate_plan_id,
    min_turnover_minor_units: plan.min_turnover_minor_units,
    max_turnover_minor_units: plan.max_turnover_minor_units,
    max_duration_years: plan.max_duration_years,
    max_member_age: plan.max_member_age,
    benefit_matrix: plan.benefit_matrix,
  };

  return (
    <FormContainer>
      <PlanBreadcrumbLabel segment={plan.plan_id} label={plan.plan_name.en} />
      <PageHeader title={t('title', { planName: plan.plan_name.en })} />
      <Card>
        <CardHeader>
          <CardTitle>{plan.plan_name.en}</CardTitle>
        </CardHeader>
        <CardContent>
          <EditPlanClient
            planId={plan.plan_id}
            planYear={plan.plan_year}
            initialValues={initialValues}
            currentYear={currentYear}
            currencyPrefix={currencyPrefix}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
