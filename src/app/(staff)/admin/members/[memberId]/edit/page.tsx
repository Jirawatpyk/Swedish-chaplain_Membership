/**
 * T094 — /admin/members/[memberId]/edit page (US3).
 *
 * Server Component — admin-only. Loads the member + contacts via
 * `getMember`, loads active plans via F2 `listPlans`, passes everything
 * to the EditMemberClient wrapper which composes MemberForm with PATCH
 * semantics + bundle-change + override dialogs.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { ContentContainer } from '@/components/layout/content-container';
import { PageHeader } from '@/components/layout/page-header';
import { EditMemberClient } from '@/components/members/edit-member-client';
import type { PlanOption } from '@/components/members/member-form';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly params: Promise<{ memberId: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) return { title: 'Edit · SweCham' };
  return { title: `Edit · SweCham` };
}

export default async function EditMemberPage({ params }: PageProps) {
  const { memberId } = await params;
  if (!UUID_RE.test(memberId)) notFound();

  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const tenant = resolveTenantFromRequest();
  const h = await headers();
  const requestId = requestIdFromHeaders(h);

  const deps = buildMembersDeps(tenant);
  const memberResult = await getMember(
    memberId as MemberId,
    { actorUserId: user.id, requestId },
    deps,
  );

  const t = await getTranslations('admin.members.edit');

  if (!memberResult.ok) {
    if (memberResult.error.type === 'not_found') notFound();
    throw new Error(`getMember: ${memberResult.error.message}`);
  }
  const { member, contacts } = memberResult.value;
  const primary = contacts.find((c) => c.isPrimary && c.removedAt === null);

  // Plans list for the dropdown
  const plansDeps = buildPlansDeps(tenant);
  const plansResult = await listPlans(
    { filter: { activeOnly: true } },
    {
      tenant: plansDeps.tenant,
      planRepo: plansDeps.planRepo,
      feeConfigRepo: plansDeps.feeConfigRepo,
      clock: plansDeps.clock,
    },
  );
  if (!plansResult.ok) {
    throw new Error('plans: fee config missing');
  }
  const plans: PlanOption[] = plansResult.value.data.map((p) => ({
    plan_id: p.plan_id,
    plan_year: p.plan_year,
    display_name: `${p.plan_name.en ?? p.plan_id} — ${p.plan_year}`,
    requires_date_of_birth: p.member_type_scope === 'individual',
  }));

  return (
    <ContentContainer>
      <PageHeader
        title={t('title')}
        subtitle={member.companyName}
        actions={
          <Link
            href={`/admin/members/${memberId}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <ArrowLeftIcon className="size-4" />
            {t('cancel')}
          </Link>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{member.companyName}</CardTitle>
        </CardHeader>
        <CardContent>
          <EditMemberClient
            member={{
              memberId: member.memberId,
              companyName: member.companyName,
              legalEntityType: member.legalEntityType,
              country: member.country,
              taxId: member.taxId,
              website: member.website,
              description: member.description,
              foundedYear: member.foundedYear,
              turnoverThb: member.turnoverThb,
              planId: member.planId,
              planYear: member.planYear,
              registrationDate: member.registrationDate
                .toISOString()
                .slice(0, 10),
            }}
            plans={plans}
            primaryContact={{
              firstName: primary?.firstName ?? '',
              lastName: primary?.lastName ?? '',
              email: primary?.email ?? '',
              phone: primary?.phone ?? null,
              roleTitle: primary?.roleTitle ?? null,
              preferredLanguage:
                (primary?.preferredLanguage as 'en' | 'th' | 'sv') ?? 'en',
            }}
          />
        </CardContent>
      </Card>
    </ContentContainer>
  );
}
