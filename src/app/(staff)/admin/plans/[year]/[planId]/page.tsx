/**
 * T087 — /admin/plans/[year]/[planId] detail page (US1).
 *
 * Plan detail view: fee (with the VAT-inclusive total), eligibility,
 * the number of members on the plan, and the full benefit matrix grouped
 * by category (Brand Visibility / Events / Additional / Partnership).
 * `plans.write` holders also get Edit + the actions menu (Activate /
 * Deactivate, Delete, Restore) in the header.
 * Server component — loads via `getPlan` use case, 404s via
 * `notFound()` when the plan doesn't exist (or belongs to another
 * tenant — RLS handles that case transparently).
 *
 * 122 US6 (T603, T609): the page loads the data and renders
 * `renderPlanDetailView` (`_components/plan-detail-view.tsx`), which the
 * no-DB preview route renders too.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';
import {
  asPlanSlug,
  asPlanYear,
  getPlan,
  grossWithVatMinorUnits,
  vatRatePercent,
} from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { renderPlanDetailView } from './_components/plan-detail-view';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}): Promise<Metadata> {
  const { year, planId } = await params;
  const yearNum = Number(year);
  const tPlans = await getTranslations('admin.plans');
  if (!Number.isInteger(yearNum) || !/^[a-z0-9-]{1,63}$/.test(planId)) {
    // Invalid url params (uuid/year format mismatch) — page itself
    // notFound()s; metadata just falls back to the list-page title.
    return { title: tPlans('title') };
  }
  const tenant = resolveTenantFromRequest();
  const deps = buildPlansDeps(tenant);
  const plan = await deps.planRepo.findOne(
    tenant,
    asPlanSlug(planId),
    asPlanYear(yearNum),
  );
  const displayName = plan?.plan_name.en ?? planId;
  // Layout template appends "· SweCham Membership" automatically.
  return { title: `${displayName} · ${tPlans('title')}` };
}

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ year: string; planId: string }>;
}) {
  const { user: currentUser } = await requirePagePermission('plans.read');
  const { year, planId } = await params;

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

  // R8 — currency via F4 invoice_settings taxPolicy (consolidated).
  const taxPolicy = await deps.taxPolicy();
  const currencyCode = taxPolicy?.currencyCode ?? 'THB';
  const vat = taxPolicy ? vatSummary(plan.annual_fee_minor_units, taxPolicy.vatRateRaw) : null;

  // Active + inactive members on this (plan, year) — the FR-010 count the
  // delete guard uses. A failed count hides the row rather than the page.
  const memberCount = await deps.members
    .countActivePlanMembers(tenant, asPlanSlug(plan.plan_id), asPlanYear(plan.plan_year))
    .catch(() => null);

  const canWritePlans = canPerform(currentUser.role, 'plans.write');

  // Resolve includes_corporate_plan_id slug → display name
  let bundledPlanName: string | null = null;
  if (plan.includes_corporate_plan_id) {
    const linked = await deps.planRepo.findOne(
      tenant,
      asPlanSlug(plan.includes_corporate_plan_id),
      asPlanYear(plan.plan_year),
    );
    bundledPlanName = linked?.plan_name.en ?? null;
  }

  return renderPlanDetailView({
    plan,
    year,
    planId,
    canWritePlans,
    canReadMembers: canPerform(currentUser.role, 'members.read'),
    currencyCode,
    vat,
    memberCount,
    bundledPlanName,
  });
}

// VAT-inclusive total + the rate as a percentage, via the same integer math
// the plans list uses. A tax-policy rate the domain rejects hides the row
// instead of failing the page.
function vatSummary(
  feeMinorUnits: number,
  vatRateRaw: string,
): { readonly totalMinorUnits: number; readonly ratePercent: number } | null {
  try {
    return {
      totalMinorUnits: grossWithVatMinorUnits(feeMinorUnits, vatRateRaw),
      ratePercent: vatRatePercent(vatRateRaw),
    };
  } catch {
    return null;
  }
}
