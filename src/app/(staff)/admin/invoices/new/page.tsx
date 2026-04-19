/**
 * T056 — /admin/invoices/new — create draft form (server-loaded dropdowns).
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { CreateDraftForm, type MemberOption, type PlanOption } from '../_components/invoice-form';

export default async function NewInvoiceDraftPage() {
  const t = await getTranslations('admin.invoices.new');
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const currentYear = new Date().getFullYear();

  // Plans — active only, current year.
  const plansDeps = buildPlansDeps(tenantCtx);
  const plansResult = await listPlans(
    { filter: { year: currentYear as never, activeOnly: true } },
    plansDeps,
  );
  function resolvePlanName(rawName: unknown, fallback: string): string {
    if (typeof rawName === 'object' && rawName !== null) {
      return (rawName as { en?: string }).en ?? fallback;
    }
    return String(rawName ?? fallback);
  }

  const plans: readonly PlanOption[] = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        planId: p.plan_id,
        label: resolvePlanName(p.plan_name, p.plan_id),
        annualFeeMinorUnits: Number(p.annual_fee_minor_units),
      }))
    : [];

  // Build a fast lookup planId -> display name — used when composing
  // the member label so admins see "Fogmaker Thailand Demo (Regular
  // Corporate / 2026)" instead of the raw "regular" slug.
  const planNameById = new Map<string, string>(plans.map((p) => [p.planId, p.label]));

  // Active members — ceiling 500 covers SweCham 2026 count (~131)
  // with comfortable headroom for mid-year growth. Tenants larger
  // than this need server-paged search in a follow-up polish
  // (tracked as F4 Phase 10 smart-chamber feature #2).
  const membersDeps = buildMembersDeps(tenantCtx);
  const membersResult = await directorySearch(membersDeps, {
    limit: 500,
    status: ['active'] as const,
  });
  const members: readonly MemberOption[] = membersResult.ok
    ? membersResult.value.items.map((r) => {
        const planLabel = planNameById.get(r.member.planId) ?? r.member.planId;
        return {
          memberId: r.member.memberId,
          label: `${r.member.companyName} (${planLabel} / ${r.member.planYear})`,
          currentPlanId: r.member.planId,
          currentPlanYear: r.member.planYear,
        };
      })
    : [];

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent>
          <CreateDraftForm members={members} plans={plans} />
        </CardContent>
      </Card>
      <Link
        href="/admin/invoices"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t('cancel')}
      </Link>
    </FormContainer>
  );
}
