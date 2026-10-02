/**
 * 122 US6 (T605–T607, T609) — the new, edit and clone plan pages' views,
 * shared by the pages and the no-DB preview route
 * (`/test-fixtures/aura-admin?view=plan-new|plan-edit|plan-edit-locked|plans-clone`),
 * so the screenshots show the pages themselves, never a copy of their layout.
 *
 * Each page wraps its view in its own `FormContainer` (check:layout reads the
 * page file) with `align="start"`: the boards set the form column at the
 * page's start edge, not centred (spec 122 `spec.md:118`), as on the member
 * forms. The column is AURA's narrow `Container` (720px outer, the page gutter
 * inside it; the maintainer's width decision of 2 Oct 2026).
 */
import { getLocale, getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { formatCalendarYear } from '@/lib/format-date-localised';
import type { PlanSchemaInput } from '@/modules/plans';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import type { CurrentYearPlanStatus } from '@/components/plans/prior-year-lock-banner';
import { NewPlanClient } from '../new/new-plan-client';
import { EditPlanClient } from '../[year]/[planId]/edit/edit-plan-client';
import { CloneYearClient, type CloneSourcePlan } from '../clone/clone-year-client';

/** Board `Admin-plan-new`: the stepper and one card per step under the title. */
export async function renderNewPlanView({
  currentYear,
  currencyCode,
  vatRatePercent,
}: {
  readonly currentYear: number;
  readonly currencyCode: string;
  readonly vatRatePercent: number | null;
}) {
  const t = await getTranslations('admin.plans.create');
  return (
    <>
      <PageHeader title={t('title')} />
      <NewPlanClient
        currentYear={currentYear}
        currencyUnit={currencyCode}
        currencyCode={currencyCode}
        vatRatePercent={vatRatePercent}
      />
    </>
  );
}

/**
 * Boards `Admin-plan-edit` and `-locked`: the form's cards under the title; a
 * prior-year plan names its year under it.
 */
export async function renderPlanEditView({
  initialValues,
  currentYear,
  currencyCode,
  currentYearStatus,
  vatRatePercent,
}: {
  readonly initialValues: PlanSchemaInput;
  readonly currentYear: number;
  readonly currencyCode: string;
  readonly currentYearStatus: CurrentYearPlanStatus;
  readonly vatRatePercent: number | null;
}) {
  const t = await getTranslations('admin.plans.edit');
  const locale = await getLocale();
  const { plan_id: planId, plan_year: planYear, plan_name: planName } = initialValues;
  return (
    <>
      <PlanBreadcrumbLabel segment={planId} label={planName.en} />
      <PageHeader
        title={t('title', { planName: planName.en })}
        subtitle={planYear < currentYear ? formatCalendarYear(planYear, locale) : undefined}
      />
      <EditPlanClient
        planId={planId}
        planYear={planYear}
        initialValues={initialValues}
        currentYear={currentYear}
        currencyUnit={currencyCode}
        currentYearStatus={currentYearStatus}
        vatRatePercent={vatRatePercent}
      />
    </>
  );
}

/** Board `Admin-plans-clone`: one card; its action bar is the card's last child. */
export async function renderCloneYearView({
  sourceYear,
  targetYear,
  currencyCode,
  sourcePlans,
}: {
  readonly sourceYear: number;
  readonly targetYear: number;
  readonly currencyCode: string;
  readonly sourcePlans: readonly CloneSourcePlan[];
}) {
  const t = await getTranslations('admin.plans.clone');
  return (
    <>
      <PageHeader title={t('title')} />
      <Card title={t('title')} headingLevel={2}>
        <CloneYearClient
          defaultSourceYear={sourceYear}
          defaultTargetYear={targetYear}
          currencyCode={currencyCode}
          defaultSourcePlans={sourcePlans}
        />
      </Card>
    </>
  );
}
