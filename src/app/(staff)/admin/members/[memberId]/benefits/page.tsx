/**
 * F9 US4 (T066) — /admin/members/[memberId]/benefits (staff benefit view).
 *
 * Staff (admin + manager) see any member's benefit usage — identical figures
 * to what the member sees (AS-4), plus an admin-only "send reminder" action
 * (a mailto to the member's primary contact, no new endpoint). Reuses the
 * shared `BenefitUsageCard` so member + staff variants never diverge.
 *
 * AS-4 lists two illustrative admin actions ("send reminder / suggest usage").
 * The "suggest usage" nudge is folded into the reminder: the localised mailto
 * subject prompts the member to make the most of their benefits — one real
 * action rather than a second button that would have no distinct endpoint.
 *
 * PII read: emits `member_benefit_viewed` (FR-036) best-effort + the SC-012
 * metric via `recordStaffBenefitView`. Member existence (404 / cross-tenant
 * probe audit) is handled by `getMember`, mirroring the timeline staff page.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeftIcon, MailIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  computeBenefitUsage,
  makeComputeBenefitUsageDeps,
  recordStaffBenefitView,
} from '@/modules/insights';
import { getMember, type MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { BenefitUsageCard } from '@/components/benefits/benefit-usage-card';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.members.benefits');
  return { title: t('title') };
}

export default async function MemberBenefitsPage({ params }: PageProps) {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const session = await requireSession('staff');
  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);
  const locale = await getLocale();

  const t = await getTranslations('admin.members.benefits');
  const tDetail = await getTranslations('admin.members.detail');

  const deps = buildMembersDeps(tenant);
  const memberResult = await getMember(
    memberId as MemberId,
    { actorUserId: session.user.id, requestId },
    deps,
  );
  if (!memberResult.ok) {
    if (memberResult.error.type === 'not_found') {
      return (
        <DetailContainer>
          <Card>
            <CardContent className="flex flex-col items-center gap-4 p-10 text-center">
              <h2 className="text-h2 text-xl font-semibold">
                {tDetail('notFound.title')}
              </h2>
              <p className="text-sm text-muted-foreground">
                {tDetail('notFound.description')}
              </p>
              <Link
                href="/admin/members"
                className={buttonVariants({ variant: 'outline' })}
              >
                <ArrowLeftIcon className="size-4" />
                {tDetail('notFound.cta')}
              </Link>
            </CardContent>
          </Card>
        </DetailContainer>
      );
    }
    // Use the discriminant code, not error.message — a raw repo message can
    // carry SQL/table fragments (forbidden-fields hygiene, R I-5).
    throw new Error(`getMember failed: ${memberResult.error.type}`);
  }
  const { member, contacts } = memberResult.value;

  const result = await computeBenefitUsage(
    tenant,
    { memberId },
    makeComputeBenefitUsageDeps(tenant.slug),
  );
  if (!result.ok) {
    throw new Error(`computeBenefitUsage failed: ${result.error.code}`);
  }
  const usage = result.value;

  // requireSession('staff') admits only admin + manager, but the Role union
  // includes 'member' — validate rather than cast (R I-3) so a future RBAC
  // regression can't silently write an inaccurate actor_role to the audit row.
  const actorRole = session.user.role;
  if (actorRole !== 'admin' && actorRole !== 'manager') {
    throw new Error(`unexpected role on staff benefits route: ${actorRole}`);
  }

  // PII-read trail + SC-012 metric (best-effort; never blocks the read).
  await recordStaffBenefitView({
    tenantId: tenant.slug,
    requestId,
    actorUserId: session.user.id,
    actorRole,
    subjectMemberId: member.memberId,
    membershipYear: usage.membershipYear,
  });

  // Admin-only "send reminder" → mailto the active primary contact (AS-4).
  const primaryEmail = contacts.find((c) => c.isPrimary && c.removedAt === null)?.email;
  const reminderHref =
    primaryEmail === undefined
      ? undefined
      : `mailto:${primaryEmail}?subject=${encodeURIComponent(
          t('staffActions.reminderSubject', { company: member.companyName }),
        )}`;

  return (
    <DetailContainer>
      <PageHeader
        title={t('title')}
        subtitle={member.companyName}
        actions={
          <Link
            href={`/admin/members/${member.memberId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            <ArrowLeftIcon className="size-4" />
            {t('backToDetail')}
          </Link>
        }
      />
      <BenefitUsageCard
        locale={locale}
        membershipYear={usage.membershipYear}
        elapsedYearPct={usage.elapsedYearPct}
        quantifiable={usage.quantifiable}
        active={usage.active}
        aggregateConsumedPct={usage.aggregateConsumedPct}
        underUseWarning={usage.underUseWarning}
        staffActions={
          reminderHref !== undefined ? (
            <a
              href={reminderHref}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <MailIcon className="size-4" />
              {t('staffActions.sendReminder')}
            </a>
          ) : undefined
        }
      />
    </DetailContainer>
  );
}
