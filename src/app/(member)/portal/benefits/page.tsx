/**
 * 058 G1 — /portal/benefits with tabs [Benefits] [Broadcasts] (spec §4.4).
 *
 * Active tab driven by ?tab=benefits|broadcasts (default benefits). The active
 * panel is rendered SERVER-side; the client <BenefitsTabs> supplies the tab
 * chrome + writes ?tab= on switch (so deep-link / back / share work). memberId
 * comes from the session (`findByLinkedUserId`), never the URL — a member can
 * only ever see their own benefits (mirrors the /portal/timeline self-scoping).
 *
 * A genuine member-lookup or benefit-usage compute failure throws to the error
 * boundary (never masked as an empty view); an unlinked account renders the
 * benign empty state. Emits the SC-012 self-view adoption metric (no PII-read
 * audit — a member reading their own benefits is not a third-party PII access).
 */
import type { Metadata } from 'next';
import { UserX } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { insightsMetrics } from '@/lib/metrics';
import { computeBenefitUsage, makeComputeBenefitUsageDeps } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import {
  BenefitUsageCard,
  type BenefitUsageItem,
} from '@/components/benefits/benefit-usage-card';
import { BenefitsTabs } from './_components/benefits-tabs';
import { BroadcastsPanel } from './_components/broadcasts-panel';
import { resolveBenefitsTab, BENEFITS_TAB } from './_helpers/tabs';

// E-Blast compose target. The former e-blasts page (now becoming a thin
// redirect, T6) routed its Compose CTA at /portal/broadcasts/new — point the
// benefit-card eblast action + the under-use warning there directly so they
// land on the live compose surface rather than a redirect hop.
const EBLAST_COMPOSE_HREF = '/portal/broadcasts/new';

/** 60-second segment-level revalidate — carried forward from the former
 *  /portal/benefits/e-blasts page (CHK056). Keeps the composite Benefits page
 *  within the §10 TTFB budget. */
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('benefits.page');
  return { title: t('title') };
}

export default async function PortalBenefitsPage(props: {
  searchParams: Promise<{ tab?: string; page?: string }>;
}) {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('benefits.page');
  const locale = await getLocale();
  const { tab, page } = await props.searchParams;
  const activeTab = resolveBenefitsTab(tab);

  // Broadcast-tab pagination param. Clamp to [1, 1000] so a hand-crafted
  // ?page=-5 / ?page=99999 can't drive an out-of-range DB offset; the panel
  // itself derives totalPages and renders the empty-state past the last page.
  const rawPage = Number(page ?? '1') || 1;
  const requestedPage = Math.min(1_000, Math.max(1, rawPage));

  const deps = buildMembersDeps(tenant);
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { errKind: errKind(memberResult.error) },
        'portal.benefits.member_lookup_failed',
      );
      throw new Error('Failed to load member for benefits');
    }
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <UserX aria-hidden="true" className="size-10 text-muted-foreground/60" />
            <p className="text-lg font-semibold">{t('emptyTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </CardContent>
        </Card>
      </DetailContainer>
    );
  }
  const member = memberResult.value;

  // Render only the ACTIVE panel server-side. The inactive panel stays null so
  // we never do the other tab's DB roundtrips on a page that won't show them.
  let benefitsPanel: React.ReactNode = null;
  if (activeTab === BENEFITS_TAB.benefits) {
    const result = await computeBenefitUsage(
      tenant,
      { memberId: member.memberId },
      makeComputeBenefitUsageDeps(tenant.slug),
    );
    if (!result.ok) {
      // member_not_found is impossible here (we just resolved the member); any
      // failure is a genuine compute error → error boundary, never empty.
      throw new Error(`computeBenefitUsage failed: ${result.error.code}`);
    }
    const usage = result.value;
    insightsMetrics.benefitViewed('member', tenant.slug);

    const quantifiable: BenefitUsageItem[] = usage.quantifiable.map((b) =>
      b.key === 'eblast' ? { ...b, actionHref: EBLAST_COMPOSE_HREF } : { ...b },
    );

    benefitsPanel = (
      <BenefitUsageCard
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        warningActionHref={EBLAST_COMPOSE_HREF}
        headingId="benefits-panel-heading"
      />
    );
  }

  const broadcastsPanel =
    activeTab === BENEFITS_TAB.broadcasts ? (
      <BroadcastsPanel requestedPage={requestedPage} />
    ) : null;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
      <BenefitsTabs
        active={activeTab}
        benefitsPanel={benefitsPanel}
        broadcastsPanel={broadcastsPanel}
      />
    </DetailContainer>
  );
}
