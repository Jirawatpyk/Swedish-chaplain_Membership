/**
 * 124 — `/admin/finance`, the invoice dashboard: receivables and collections
 * at a glance, each figure linking to the invoices it summarises (spec 124).
 *
 * Gate (US4.3): `invoicing.read` (the page guard), then the flag, then
 * `insights.finance`; either refusal is `notFound()`, which the admin shell
 * renders as "Page not available". The role cut on what a viewer may DO is
 * made by the loaders (`canWrite`), so a manager's HTML never carries an
 * action (US4.2).
 *
 * One `now` / `today` per request: the tenant's fiscal start month gives the
 * current FY, the URL is parsed against it, and every loader gets the same
 * input. The six loaders start together; aging is read once and handed to the
 * tiles so Outstanding always equals the aging total. The page waits only for
 * the tiles (they decide the "No invoices yet" state); every other card
 * streams in its own Suspense island.
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { runInTenant } from '@/lib/db';
import { bangkokLocalDate, deriveFiscalYear, type FiscalYearStartMonth } from '@/lib/fiscal-year';
import { resolvePlanName } from '@/lib/resolve-plan-name';
import { asTenantContext } from '@/modules/tenants';
import { readFiscalYearStartMonthInTx } from '@/modules/invoicing';
import { asPlanYear, listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  fiscalYearDateRange,
  loadInvoiceDashboardAging,
  loadInvoiceDashboardAttention,
  loadInvoiceDashboardMethods,
  loadInvoiceDashboardOldestOverdue,
  loadInvoiceDashboardTiles,
  loadInvoiceDashboardTrend,
  makeLoadInvoiceDashboardDeps,
  parseInvoiceDashboardFilters,
  type InvoiceDashboardLoadInput,
  type InvoiceDashboardSearchParams,
} from '@/modules/insights';
import { renderInvoiceDashboardView } from './_components/invoice-dashboard-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoiceDashboard.meta');
  return { title: t('title') };
}

/** A stored start month outside 1–12 (or none) reads as January, as the insights adapter does. */
function asStartMonth(raw: number | null): FiscalYearStartMonth {
  return raw !== null && Number.isInteger(raw) && raw >= 1 && raw <= 12
    ? (raw as FiscalYearStartMonth)
    : 1;
}

export default async function InvoiceDashboardPage({
  searchParams,
}: {
  searchParams: Promise<InvoiceDashboardSearchParams>;
}) {
  const { user } = await requirePagePermission('invoicing.read');
  if (!env.features.invoiceDashboard) notFound();
  if (!canPerform(user.role, 'insights.finance')) notFound();

  const tenantCtx = resolveTenantFromHeaders(await headers());
  const ctx = asTenantContext(tenantCtx.slug);
  const locale = await getLocale();
  const now = new Date();
  const today = bangkokLocalDate(now.toISOString());

  const [storedStartMonth, plansResult, params] = await Promise.all([
    runInTenant(ctx, (tx) => readFiscalYearStartMonthInTx(tx, tenantCtx.slug)),
    // The Plan filter offers this Bangkok year's active plans.
    listPlans(
      { filter: { year: asPlanYear(Number(today.slice(0, 4))), activeOnly: true } },
      buildPlansDeps(tenantCtx),
    ),
    searchParams,
  ]);
  const startMonth = asStartMonth(storedStartMonth);
  const currentFiscalYear = deriveFiscalYear(now.toISOString(), startMonth);
  const filters = parseInvoiceDashboardFilters(params, {
    currentFiscalYear,
    autoInvoiceEnabled: env.features.autoInvoice,
  });
  const input: InvoiceDashboardLoadInput = {
    filters,
    today,
    now,
    fiscalYearRange: fiscalYearDateRange(filters.fiscalYear, startMonth),
    canWrite: canPerform(user.role, 'invoicing.write'),
  };

  const deps = makeLoadInvoiceDashboardDeps();
  const aging = loadInvoiceDashboardAging(ctx, input, deps);
  const tiles = aging.then((a) => loadInvoiceDashboardTiles(ctx, input, deps, a.ok ? a.value : undefined));
  const attention = loadInvoiceDashboardAttention(ctx, input, deps);
  const oldestOverdue = loadInvoiceDashboardOldestOverdue(ctx, input, deps);
  const trend = loadInvoiceDashboardTrend(ctx, input, deps);
  const methods = loadInvoiceDashboardMethods(ctx, input, deps);

  const plans = plansResult.ok
    ? plansResult.value.data.map((p) => ({ id: p.plan_id, label: resolvePlanName(p.plan_name, p.plan_id, locale) }))
    : [];

  return renderInvoiceDashboardView({
    locale,
    now,
    input,
    currentFiscalYear,
    startMonth,
    autoInvoiceEnabled: env.features.autoInvoice,
    plans,
    tiles: await tiles,
    aging,
    attention,
    oldestOverdue,
    trend,
    methods,
  });
}
