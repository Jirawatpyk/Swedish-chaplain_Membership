/**
 * T052 — /admin/members/new create page (US1 MVP).
 *
 * Server Component — loads the active plans list via F2 `listPlans`
 * so the MemberForm's plan dropdown has concrete options. Guards by
 * admin role (members:write).
 *
 * FR-037: page title "Add member · SweCham" via generateMetadata.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CreateMemberClient } from '@/components/members/create-member-client';
import { buildPlanOptions, type PlanOption } from '@/components/members/member-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.members.create');
  return { title: t('pageTitle') };
}

export default async function NewMemberPage() {
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

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
      <FormContainer>
        <PageHeader title={t('title')} />
        <Card>
          <CardContent className="p-6">
            <p className="text-sm text-destructive" role="alert">
              {t('errors.planMissing')}
            </p>
          </CardContent>
        </Card>
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
    <FormContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link
            href="/admin/members"
            className={buttonVariants({ variant: 'outline' })}
          >
            <ArrowLeftIcon className="size-4" />
            {t('cancel')}
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {plans.length === 0 ? (
            <p className="text-sm text-destructive" role="alert">
              {t('errors.planMissing')}
            </p>
          ) : (
            <CreateMemberClient
              plans={plans}
              defaultPlanYear={defaultPlanYear}
            />
          )}
        </CardContent>
      </Card>
    </FormContainer>
  );
}
