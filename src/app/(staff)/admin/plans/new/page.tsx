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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { NewPlanClient } from './new-plan-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'New plan · SweCham' };
}

export default async function NewPlanPage() {
  const { user: currentUser } = await requireSession('staff');
  if (currentUser.role !== 'admin') {
    redirect('/admin/plans');
  }

  const t = await getTranslations('admin.plans.create');

  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const feeConfig = await deps.feeConfigRepo.findByTenant(deps.tenant);
  const currentYear = deps.clock.currentYear();
  const currencyPrefix = feeConfig?.currency_code === 'THB' ? '฿' : (feeConfig?.currency_code ?? 'THB');

  return (
    <main className="mx-auto max-w-4xl space-y-4 py-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <NewPlanClient currentYear={currentYear} currencyPrefix={currencyPrefix} />
        </CardContent>
      </Card>
    </main>
  );
}
