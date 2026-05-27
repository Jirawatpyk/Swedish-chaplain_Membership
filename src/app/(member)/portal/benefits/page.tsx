/**
 * F9 US4 (T065) — /portal/benefits (member's own benefit usage dashboard).
 *
 * The member sees, for the current membership year, their consumption vs
 * entitlement for each quantifiable benefit + the under-use warning + their
 * active/unlimited benefits (FR-019–FR-023). The member is resolved from the
 * session (`findByLinkedUserId`), never the URL — a member can only ever see
 * their own benefits (mirrors the /portal/timeline self-scoping).
 *
 * A genuine compute failure throws to the error boundary (never masked as an
 * empty view); an unlinked account renders the benign empty state. Emits the
 * SC-012 self-view adoption metric (no PII-read audit — a member reading their
 * own benefits is not a third-party PII access).
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

const EBLAST_COMPOSE_HREF = '/portal/benefits/e-blasts';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('benefits.page');
  return { title: t('title') };
}

export default async function PortalBenefitsPage() {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const t = await getTranslations('benefits.page');
  const locale = await getLocale();

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
    b.key === 'eblast'
      ? { ...b, actionHref: EBLAST_COMPOSE_HREF }
      : { ...b },
  );

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitleMember')} />
      <BenefitUsageCard
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        warningActionHref={EBLAST_COMPOSE_HREF}
      />
    </DetailContainer>
  );
}
