/**
 * T110 — /admin/plans/clone page (US2).
 *
 * Server component that loads the list of plans for the current year
 * (so the confirmation dialog can accurately quote the row count +
 * the target year defaults to `current + 1`), then hands off to the
 * client `<CloneYearClient>` shell for source/target pickers + the
 * CloneYearDialog confirmation.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listPlans, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CloneYearClient } from './clone-year-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Clone year · SweCham' };
}

export default async function CloneYearPage() {
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') {
    redirect('/admin/plans');
  }

  const t = await getTranslations('admin.plans.clone');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const currentYear = deps.clock.currentYear();

  // Load the default source year's catalogue so we can seed the
  // confirmation dialog with an accurate row count.
  const listResult = await listPlans(
    { filter: { year: asPlanYear(currentYear) } },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      taxPolicy: deps.taxPolicy,
      clock: deps.clock,
    },
  );
  const currentYearPlanCount = listResult.ok ? listResult.value.data.length : 0;

  return (
    <FormContainer>
      <PageHeader title={t('title')} />
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CloneYearClient
            defaultSourceYear={currentYear}
            defaultTargetYear={currentYear + 1}
            defaultSourcePlanCount={currentYearPlanCount}
          />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
