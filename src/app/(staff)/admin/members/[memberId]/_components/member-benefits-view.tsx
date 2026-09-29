/**
 * 122 US5b-1 (T558) — the member benefits page's markup once loaded (board
 * `Admin-member-benefits`), shared with the no-DB preview route: the title
 * with the company under it and "Back to member" (from `lg`; below it the
 * shell's back link does the same), then the benefit-usage card (already
 * AURA) with "Send reminder" when the page passes its link.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon, MailIcon } from 'lucide-react';
import { buttonClass } from '@jirawatpyk/aura-react/server';
import type { computeBenefitUsage } from '@/modules/insights';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { DynamicBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';

type BenefitUsage = Extract<Awaited<ReturnType<typeof computeBenefitUsage>>, { ok: true }>['value'];

export interface MemberBenefitsViewProps {
  readonly member: { readonly memberId: string; readonly companyName: string };
  /** The route's `[memberId]` as typed, for the breadcrumb match (a UUID may arrive in upper case). */
  readonly routeSegment?: string;
  readonly usage: Pick<
    BenefitUsage,
    'membershipYear' | 'elapsedYearPct' | 'quantifiable' | 'active' | 'aggregateConsumedPct' | 'underUseWarning'
  >;
  /** Shows the "Suspended" badge only — staff can always view the benefits. */
  readonly suspended: boolean;
  /** `mailto:` to the primary contact, for a writer; otherwise no action. */
  readonly reminderHref: string | undefined;
  readonly locale: string;
}

export async function renderMemberBenefitsView({
  member,
  routeSegment,
  usage,
  suspended,
  reminderHref,
  locale,
}: MemberBenefitsViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.benefits');
  return (
    <DetailContainer>
      <DynamicBreadcrumbLabel segment={routeSegment ?? member.memberId} label={member.companyName} />
      <PageHeader
        title={t('title')}
        subtitle={member.companyName}
        actions={
          <>
            <Link
              href={`/admin/members/${member.memberId}`}
              className={buttonClass({ variant: 'secondary', className: 'max-lg:hidden' })}
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {t('backToDetail')}
            </Link>
            {/* The phone board puts Send reminder under the title; the card
                head holds it from sm up. One is display:none at each width. */}
            {reminderHref !== undefined && (
              <a href={reminderHref} className={buttonClass({ variant: 'secondary', className: 'sm:hidden' })}>
                <MailIcon className="size-4" aria-hidden="true" />
                {t('staffActions.sendReminder')}
              </a>
            )}
          </>
        }
      />
      <BenefitUsageCard
        variant="staff"
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={usage.quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        suspended={suspended}
        staffSubjectName={member.companyName}
        staffActions={
          reminderHref !== undefined ? (
            <a href={reminderHref} className={buttonClass({ variant: 'secondary', size: 'sm', className: 'max-sm:hidden' })}>
              <MailIcon className="size-4" aria-hidden="true" />
              {t('staffActions.sendReminder')}
            </a>
          ) : undefined
        }
      />
    </DetailContainer>
  );
}
