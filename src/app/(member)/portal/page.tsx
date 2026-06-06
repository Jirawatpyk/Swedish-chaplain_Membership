import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getLocale, getTranslations } from 'next-intl/server';
import { PackageOpen } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { formatMemberNumber, resolveMemberNumberPrefix } from '@/modules/members';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';
import Link from 'next/link';
import { InvoicesSummaryCard } from '@/components/portal/invoices-summary-card';
import {
  StatSkeleton,
  MembershipStatSection,
} from './_components/membership-stat-section';
import { OutstandingStatSection } from './_components/outstanding-stat-section';
import { BenefitsStatSection } from './_components/benefits-stat-section';
import { QuickActions } from './_components/quick-actions';
import {
  RecentActivitySection,
  RecentActivitySkeleton,
} from './_components/recent-activity-section';
import { isRenewDue, deriveBenefitsStat } from './_lib/dashboard-stats';
import {
  loadDashboardRenewalCycle,
  loadDashboardBenefitUsage,
} from './_components/dashboard-reads';

const PORTAL_BENEFITS_HREF = '/portal/benefits';

/**
 * Member portal landing — `/portal` (Dashboard, 057 redesign).
 *
 * Assembles the at-a-glance hub: PageHeader (welcome + member# + status chips)
 * → 3 stat sections (each in its own Suspense boundary) → quick actions
 * → 2-col latest invoices + benefits quota panel → recent activity.
 *
 * First-run / not-linked members see a friendly localised actionable empty hub
 * (spec §4.1 MANDATORY) instead of zeroes or blank lists.
 *
 * Constitution Principle I: all member data reads go through module barrels
 * with tenant-scoped deps. The cross-tenant regression guard lives at
 * `tests/integration/portal/dashboard-cross-tenant.test.ts`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth.memberPortal');
  return { title: t('title') };
}

export default async function MemberPortalHomePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.dashboard');
  const locale = await getLocale();

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);
  const memberRes = await deps.memberRepo.findByLinkedUserId(tenant, user.id);

  // First-run / not-linked member: friendly, localised, actionable empty hub
  // (spec §4.1 MANDATORY) — never zeroes + blank lists. ~131 launch invitees
  // all land here first.
  if (!memberRes.ok) {
    return (
      <DetailContainer>
        <PageHeader
          title={t('welcome', { name: user.displayName ?? user.email })}
          subtitle={t('intro')}
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <PackageOpen aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="text-lg font-semibold">
              {t('firstRun.title', {
                tenant: process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham',
              })}
            </p>
            <p className="max-w-prose text-sm text-muted-foreground">{t('firstRun.body')}</p>
            <Link
              href={PORTAL_BENEFITS_HREF}
              className={cn(buttonVariants({ variant: 'default' }), 'min-h-11')}
            >
              {t('firstRun.exploreBenefits')}
            </Link>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }

  const member = memberRes.value;
  const memberId = member.memberId;

  // Resolve the member number for the header chip (RLS-safe prefix resolver).
  // `member.memberNumber` is already a branded MemberNumber (validated by
  // rowToMember) — pass it straight through, no re-wrap needed.
  const memberNumberLabel = formatMemberNumber(
    await resolveMemberNumberPrefix(tenant, deps.memberSettings),
    member.memberNumber,
  );

  // Renew-CTA gating: reuse the per-request cached cycle read (no extra
  // round-trip). tenantId threaded explicitly so React cache() key works.
  const cycle = await loadDashboardRenewalCycle(tenant.slug, memberId);
  const renewDue = isRenewDue(cycle, new Date());

  // Benefits quota panel (compact card) — reuse loadDashboardBenefitUsage
  // once; React cache() deduplicates the call for BenefitsStatSection.
  const usage = await loadDashboardBenefitUsage(tenant, memberId);
  const benefitsStat = usage !== null ? deriveBenefitsStat(usage) : null;

  const statusChipKey =
    member.status === 'archived'
      ? ('archived' as const)
      : member.status === 'active'
        ? ('active' as const)
        : ('inactive' as const);

  return (
    <DetailContainer>
      <PageHeader
        title={t('welcome', { name: user.displayName ?? user.email })}
        subtitle={t('intro')}
        badge={
          <span className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono">
              {memberNumberLabel}
            </Badge>
            <Badge variant="secondary">{t(`statusChip.${statusChipKey}`)}</Badge>
          </span>
        }
      />

      {/* 3 stat cards — 1 col mobile, 3-up desktop. Each in its own Suspense
          boundary so a slow read never blocks the others. The sections share
          the per-request cached reads from dashboard-reads.ts. */}
      <div className="grid grid-cols-1 gap-[var(--page-section-gap)] sm:grid-cols-3">
        <Suspense fallback={<StatSkeleton />}>
          <MembershipStatSection tenantId={tenant.slug} memberId={memberId} />
        </Suspense>
        <Suspense fallback={<StatSkeleton />}>
          <OutstandingStatSection tenantId={tenant.slug} memberId={memberId} />
        </Suspense>
        <Suspense fallback={<StatSkeleton />}>
          <BenefitsStatSection ctx={tenant} memberId={memberId} />
        </Suspense>
      </div>

      <QuickActions memberId={memberId} renewDue={renewDue} />

      {/* 2-col: latest invoices | benefits quota. Stacks to 1-col on mobile. */}
      <div className="grid grid-cols-1 gap-[var(--page-section-gap)] lg:grid-cols-2">
        <InvoicesSummaryCard user={user} />
        {usage !== null && benefitsStat !== null && benefitsStat.kind !== 'empty' ? (
          <BenefitUsageCard
            locale={locale}
            membershipYear={usage.membershipYear}
            elapsedYearPct={usage.elapsedYearPct}
            quantifiable={usage.quantifiable}
            active={usage.active}
            aggregateConsumedPct={usage.aggregateConsumedPct}
            underUseWarning={usage.underUseWarning}
            compact
            previewHref={PORTAL_BENEFITS_HREF}
            headingId="dashboard-benefits-panel"
          />
        ) : null}
      </div>

      <Suspense fallback={<RecentActivitySkeleton />}>
        <RecentActivitySection userId={user.id} memberId={memberId} />
      </Suspense>
    </DetailContainer>
  );
}
