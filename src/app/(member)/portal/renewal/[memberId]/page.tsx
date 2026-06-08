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
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { asPlanYear, listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { loadRenewalSummary, makeRenewalsDeps } from '@/modules/renewals';
import { BenefitSummary } from './_components/benefit-summary';
import { OnboardingBanner } from './_components/onboarding-banner';
import { RenewalConfirmFlow, type RenewalPlanOption } from './_components/renewal-confirm-flow';
// Round-3 test-coverage I1 fix: locale fallback resolver extracted
// to a testable utility module so the en/th/sv branching is covered
// by a unit test instead of relying on E2E for behavioural pinning.
import { resolvePlanName } from './_lib/resolve-plan-name';

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
  // UX R5/C2: tier slug → human-readable label via the same i18n
  // namespace admin surfaces use; loud-fail to slug if a future tier
  // is added without a matching key (matches K28 cycle-detail pattern).
  const tTier = await getTranslations('admin.renewals.tierBadge');
  // I16 review-fix: locale-aware date formatting via next-intl.
  const formatter = await getFormatter();
  const locale = await getLocale();

  // Resolve the session-member.
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberLookup.ok) {
    logger.warn(
      { tenantId: tenant.slug, userId: user.id },
      '[renewal-page] no member linked to session user',
    );
    notFound();
  }
  if (memberLookup.value.memberId !== urlMemberId) {
    // Deep-review fix — page-level cross-member probe MUST emit
    // `renewal_cross_member_probe` audit per the file header JSDoc
    // ("mismatch returns 404 + emits renewal_cross_member_probe").
    // The earlier silent `notFound()` left attacker URL-enumeration
    // attempts with no forensic trail. Audit emit is fire-and-forget
    // (try/catch) so a broken audit infrastructure never blocks the
    // 404 response — Constitution Principle I clause 4 / FR-027
    // generic-error policy preserved.
    try {
      const renewalsDepsForProbe = makeRenewalsDeps(tenant.slug);
      await renewalsDepsForProbe.auditEmitter.emit(
        {
          type: 'renewal_cross_member_probe',
          payload: {
            actor_member_id: memberLookup.value.memberId,
            attempted_member_id: urlMemberId as typeof memberLookup.value.memberId,
          },
        },
        {
          tenantId: tenant.slug,
          actorUserId: user.id,
          actorRole: 'member',
          correlationId: `renewal-page-probe:${urlMemberId}`,
          requestId: null,
        },
      );
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: tenant.slug,
          attemptedMemberId: urlMemberId,
        },
        '[renewal-page] cross-member probe audit emit failed (swallowed — never blocks 404)',
      );
    }
    notFound();
  }

  const renewalsDeps = makeRenewalsDeps(tenant.slug);
  const activeCycle = await renewalsDeps.cyclesRepo.findActiveForMember(tenant.slug, urlMemberId);
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
  // I15 review-fix: use the F2 branded `asPlanYear()` helper instead of
  // `as never` cast — preserves the PlanYear branded-type guarantee at
  // the F8↔F2 boundary.
  const plansResult = await listPlans(
    { filter: { year: asPlanYear(planYear), activeOnly: true } },
    plansDeps,
  );
  const availablePlans: ReadonlyArray<RenewalPlanOption> = plansResult.ok
    ? plansResult.value.data.map((p) => ({
        planId: p.plan_id,
        label: resolvePlanName(p.plan_name, p.plan_id, locale),
        annualFeeMinorUnits: Number(p.annual_fee_minor_units),
      }))
    : [];

  const currentPlanLabel =
    availablePlans.find((p) => p.planId === summary.planIdAtCycleStart)?.label ??
    summary.planIdAtCycleStart;

  // UX R5/C2: translate the frozen tier slug. Fallback emits the raw
  // slug suffixed with "(untranslated)" so missing keys are visible
  // in development without crashing the page.
  const tierKey = summary.tierAtCycleStart;
  const tierLabel = tTier.has(tierKey) ? tTier(tierKey) : `${tierKey} (untranslated)`;

  // UX R5/C1: format the frozen plan price via Intl currency rather
  // than emitting `36000.00 THB` raw — this is the price shown right
  // before the renewal CTA, so it must read as money to the member.
  const frozenPriceFormatted = formatter.number(Number(summary.frozenPlanPriceThb), {
    style: 'currency',
    currency: summary.frozenPlanCurrency ?? 'THB',
  });

  return (
    <DetailContainer>
      {/* Staff-Review-2026-05-09 WRN-7 fix: replaced handrolled
          <header><h1><p></header> with the shared <PageHeader> primitive
          used by all other portal pages (F3 self-service). PageHeader
          bakes in skip-to-content wiring, responsive margin, and the
          mobile-first stack→sm:row layout — handrolled markup made the
          visual rhythm here inconsistent with sibling portal pages. */}
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {/* I18 review-fix: OnboardingBanner moved AFTER <header> so h1 precedes
          h2 (WCAG 2.4.6 heading order) — banner only renders for first-time
          renewers; otherwise the page's heading ladder stays h1 → h2 → h2. */}
      {summary.isFirstTimeRenewer && <OnboardingBanner />}

      <Card role="region" aria-labelledby="plan-summary-heading">
        <CardContent className="flex flex-col gap-3">
          <h2 id="plan-summary-heading" className="text-h4">
            {t('membershipPlanHeading')}
          </h2>
          {/* UX R5 / Mobile #1: `grid-cols-1` base + `sm:grid-cols-2` so
              the dl reflows into a single column at <640px viewports
              where Thai plan names ("Premium Plus / สมาชิกระดับพรีเมี่ยม")
              would otherwise overflow the 136px column on a 320px
              device (WCAG 1.4.10 Reflow). */}
          <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-2 sm:gap-x-4">
            <dt className="text-muted-foreground">{tField('plan')}</dt>
            <dd>{currentPlanLabel}</dd>
            <dt className="text-muted-foreground">{tField('tier')}</dt>
            <dd>{tierLabel}</dd>
            <dt className="text-muted-foreground">{tField('frozenPrice')}</dt>
            <dd>{frozenPriceFormatted}</dd>
            <dt className="text-muted-foreground">{tField('term')}</dt>
            <dd>{tField('termMonths', { count: summary.frozenPlanTermMonths })}</dd>
            <dt className="text-muted-foreground">{tField('expiry')}</dt>
            <dd>
              <time dateTime={summary.expiresAt}>
                {formatter.dateTime(new Date(summary.expiresAt), 'dateLong')}
              </time>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <BenefitSummary benefits={summary.benefits} benefitsAvailable={summary.benefitsAvailable} />

      {/* Confirm flow wrapped in a Card so the renewal page reads as a
          consistent 3-card stack (plan summary · benefits · confirm) and
          matches the loading skeleton — was a card-less control group that
          flashed on hydration (UX R2-I2). */}
      <Card>
        <CardContent>
          <RenewalConfirmFlow
            memberId={urlMemberId}
            cycleId={summary.cycleId}
            planYear={planYear}
            currentPlanId={summary.planIdAtCycleStart}
            currentPlanLabel={currentPlanLabel}
            availablePlans={availablePlans}
          />
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
