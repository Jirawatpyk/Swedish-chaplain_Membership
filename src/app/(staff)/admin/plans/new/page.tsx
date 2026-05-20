/**
 * T109 — /admin/plans/new wizard page (US2).
 *
 * Server component boundary that:
 *   1. Guards the session via `requireSession('staff')`
 *   2. Loads the tenant fee config (currency prefix, VAT rate)
 *   3. Computes the default `current_year` from the server clock
 *      so the wizard doesn't drift across timezones
 *   4. Mounts the client `<NewPlanClient>` shell that owns the form
 *      state + submission
 *
 * Admin-only. Managers reaching this route will land here but the
 * wizard's submit path 403s at the API boundary; the shell filters
 * the nav link so this is a defence-in-depth path, not a primary
 * guard.
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { Card, CardContent } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { NewPlanClient } from './new-plan-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.plans.create');
  return { title: t('title') };
}

export default async function NewPlanPage() {
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') {
    redirect('/admin/plans');
  }

  const t = await getTranslations('admin.plans.create');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  // R8 — read currency from F4 invoice_settings (single source of
  // truth) via the plans-deps `taxPolicy` facade.
  const taxPolicy = await deps.taxPolicy();
  const currencyCode = taxPolicy?.currencyCode ?? 'THB';
  const currentYear = deps.clock.currentYear();
  const currencyPrefix = currencyCode === 'THB' ? '฿' : currencyCode;

  return (
    <FormContainer>
      <PageHeader title={t('title')} />
      <Card>
        <CardContent>
          <NewPlanClient currentYear={currentYear} currencyPrefix={currencyPrefix} />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
