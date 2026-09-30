/**
 * T052 — /admin/members/new create page (US1 MVP).
 *
 * Server Component — loads the active plans list via F2 `listPlans`
 * so the MemberForm's plan dropdown has concrete options. Guards by
 * admin role (members:write).
 *
 * FR-037: page title "Add member · SweCham" via generateMetadata.
 *
 * Spec 122 US5b-2: the board's frame (`MemberFormFrame`); the form's own
 * fieldset cards replace the one card around it.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { getTranslations, getLocale } from 'next-intl/server';
import { Alert } from '@jirawatpyk/aura-react/server';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { FormContainer } from '@/components/layout';
import { MEMBER_FORM_COLUMN, MemberFormFrame } from '../_components/member-form-frame';
import { CreateMemberClient } from '@/components/members/create-member-client';
import { buildPlanOptions, type PlanOption } from '@/components/members/member-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.members.create');
  return { title: t('pageTitle') };
}

export default async function NewMemberPage() {
  await requirePagePermission('members.write');

  // resolveTenantFromHeaders honours the T115t `x-tenant` header (same
  // pattern as the sibling [memberId] page) — WITHOUT it this page lists
  // the DEFAULT tenant's plans while POST /api/members resolves the
  // header tenant, so a throwaway-tenant E2E submits a foreign plan_id
  // and 404s on `plan_not_found`. Falls back to env.tenant.slug when the
  // header machinery is off (production).
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const deps = buildPlansDeps(tenant);
  const plansResult = await listPlans(
    { filter: { activeOnly: true } },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      taxPolicy: deps.taxPolicy,
      clock: deps.clock,
    },
  );

  const t = await getTranslations('admin.members.create');
  const locale = await getLocale();

  if (!plansResult.ok) {
    return (
      <FormContainer className={MEMBER_FORM_COLUMN}>
        <MemberFormFrame title={t('title')} cancelHref="/admin/members" cancelLabel={t('cancel')}>
          <Alert tone="danger">{t('errors.planMissing')}</Alert>
        </MemberFormFrame>
      </FormContainer>
    );
  }

  // WP2 / P1-8 — locale-aware name + annual fee threaded through the shared
  // mapper (was a hardcoded `.en`, dropping TH/SV on the plan label).
  const plans: PlanOption[] = buildPlanOptions(
    plansResult.value.data,
    locale,
    plansResult.value.meta.currency_code,
  );

  const defaultPlanYear =
    plansResult.value.meta.year ?? new Date().getUTCFullYear();

  return (
    <FormContainer className={MEMBER_FORM_COLUMN}>
      <MemberFormFrame
        title={t('title')}
        subtitle={t('subtitle')}
        cancelHref="/admin/members"
        cancelLabel={t('cancel')}
      >
        {plans.length === 0 ? (
          <Alert tone="danger">{t('errors.planMissing')}</Alert>
        ) : (
          <CreateMemberClient plans={plans} defaultPlanYear={defaultPlanYear} />
        )}
      </MemberFormFrame>
    </FormContainer>
  );
}
