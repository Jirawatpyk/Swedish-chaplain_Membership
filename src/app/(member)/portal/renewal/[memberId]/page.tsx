/**
 * F8 Phase 5 Wave C · T125 — `/portal/renewal/[memberId]` page.
 *
 * Member-facing renewal portal. Loads the cycle summary (frozen plan
 * price + benefit consumption + expiry) and renders the confirm CTA.
 *
 * Auth: requireSession('member'). The session-member's memberId MUST
 * match URL [memberId] — mismatch returns 404 + emits
 * `renewal_cross_member_probe` audit (no oracle per FR-027 generic-
 * error policy).
 *
 * Token-verified entry path (research.md R1 v2 step 9): the public
 * `?token=<...>` URL is the typical entry point. The token-verify
 * + sign-in flow lands as a follow-on — current page assumes session
 * is already established.
 */
import { notFound, redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  loadRenewalSummary,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { BenefitSummary } from './_components/benefit-summary';
import { OnboardingBanner } from './_components/onboarding-banner';
import {
  RenewalConfirmFlow,
  type RenewalPlanOption,
} from './_components/renewal-confirm-flow';

export default async function RenewalPortalPage({
  params,
}: {
  params: Promise<{ memberId: string }>;
}) {
  const { memberId: urlMemberId } = await params;
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('portal.renewal.page');
  const tField = await getTranslations('portal.renewal.fields');
  // I16 review-fix: locale-aware date formatting via next-intl.
  const formatter = await getFormatter();

  // Resolve the session-member.
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-page] no member linked to session user',
    );
    notFound();
  }
  if (memberLookup.value.memberId !== urlMemberId) {
    notFound();
  }

  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const activeCycle = await renewalsDeps.cyclesRepo.findActiveForMember(
    tenant.slug,
    urlMemberId,
  );
  if (!activeCycle) {
    redirect('/portal');
  }

  const summaryResult = await loadRenewalSummary(renewalsDeps, {
    tenantId: tenant.slug,
    cycleId: activeCycle.cycleId,
    memberId: urlMemberId,
    actorRole: 'member',
    actorUserId: user.id,
    correlationId: `renewal-page:${activeCycle.cycleId}`,
  });
  if (!summaryResult.ok) {
    logger.warn(
      { err: summaryResult.error.kind, cycleId: activeCycle.cycleId },
      '[renewal-page] loadRenewalSummary failed',
    );
    notFound();
  }
  const summary = summaryResult.value;
  const planYear = new Date(summary.expiresAt).getUTCFullYear();

  // Fetch active plans for the renewal year — feeds T128 plan-change
  // selector. Falls back to single-option list (current plan only) if
  // F2 listPlans fails so the CTA still renders.
  const plansDeps = buildPlansDeps(tenant);
  const plansResult = await listPlans(
    { filter: { year: planYear as never, activeOnly: true } },
    plansDeps,
  );
  const availablePlans: ReadonlyArray<RenewalPlanOption> = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        planId: p.plan_id,
        label: resolvePlanName(p.plan_name, p.plan_id),
        annualFeeMinorUnits: Number(p.annual_fee_minor_units),
      }))
    : [];

  const currentPlanLabel =
    availablePlans.find((p) => p.planId === summary.planIdAtCycleStart)
      ?.label ?? summary.planIdAtCycleStart;

  return (
    <DetailContainer>
      <header>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      {/* I18 review-fix: OnboardingBanner moved AFTER <header> so h1 precedes
          h2 (WCAG 2.4.6 heading order) — banner only renders for first-time
          renewers; otherwise the page's heading ladder stays h1 → h2 → h2. */}
      {summary.isFirstTimeRenewer && <OnboardingBanner />}

      <section
        aria-labelledby="plan-summary-heading"
        className="rounded-lg border bg-card p-4"
      >
        <h2
          id="plan-summary-heading"
          className="mb-3 text-lg font-medium"
        >
          {t('membershipPlanHeading')}
        </h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{tField('plan')}</dt>
          <dd>{currentPlanLabel}</dd>
          <dt className="text-muted-foreground">{tField('tier')}</dt>
          <dd>{summary.tierAtCycleStart}</dd>
          <dt className="text-muted-foreground">{tField('frozenPrice')}</dt>
          <dd>
            {summary.frozenPlanPriceThb} {summary.frozenPlanCurrency}
          </dd>
          <dt className="text-muted-foreground">{tField('term')}</dt>
          <dd>
            {tField('termMonths', { count: summary.frozenPlanTermMonths })}
          </dd>
          <dt className="text-muted-foreground">{tField('expiry')}</dt>
          <dd>
            <time dateTime={summary.expiresAt}>
              {formatter.dateTime(new Date(summary.expiresAt), {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </time>
          </dd>
        </dl>
      </section>

      <BenefitSummary
        benefits={summary.benefits}
        benefitsAvailable={summary.benefitsAvailable}
      />

      <RenewalConfirmFlow
        memberId={urlMemberId}
        cycleId={summary.cycleId}
        planYear={planYear}
        currentPlanId={summary.planIdAtCycleStart}
        currentPlanLabel={currentPlanLabel}
        availablePlans={availablePlans}
      />
    </DetailContainer>
  );
}

function resolvePlanName(rawName: unknown, fallback: string): string {
  if (typeof rawName === 'object' && rawName !== null) {
    return (rawName as { en?: string }).en ?? fallback;
  }
  return String(rawName ?? fallback);
}
