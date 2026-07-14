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
import { logger } from '@/lib/logger';
import {
  getMember,
  getMemberPreferredLocale,
  f3DrizzleMemberRepo,
} from '@/modules/members';
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
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EditMemberClient } from '@/components/members/edit-member-client';
import { AdminPreferredLocaleCard } from '@/components/admin/admin-preferred-locale-card';
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
  const t = await getTranslations('admin.members.edit');
  // Layout template appends "· SweCham Membership". Both branches
  // use the generic `title` ("Edit member") rather than the
  // `pageTitle` interpolation which requires companyName via a DB
  // lookup — the page itself does the lookup downstream.
  if (!UUID_RE.test(memberId)) return { title: t('title') };
  return { title: t('title') };
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

  // R5 verify-fix UX-H1 (2026-05-02): seed AdminPreferredLocaleCard with
  // the member's CURRENT preferred_locale so the admin sees the present
  // value before clicking Save. Without this, admin would silently reset
  // the field to null on every accidental Save. Lookup is best-effort
  // (null on F3 failure → bridge falls back to tenant default).
  const preferredLocaleResult = await getMemberPreferredLocale(
    { tenant, memberRepo: f3DrizzleMemberRepo },
    member.memberId,
  );
  if (!preferredLocaleResult.ok) {
    // R6 verify-fix Errors-LOW (2026-05-02): log Result-error so a
    // forensic trail exists when admin loads the page during a Neon
    // RLS denial / schema drift. Render still proceeds with null
    // (admin can set fresh value); ops sees the gap in pino stream.
    logger.warn(
      {
        err: preferredLocaleResult.error,
        tenantId: tenant.slug,
        memberId: member.memberId,
        actorUserId: user.id,
      },
      'admin.edit_page.preferred_locale_lookup_failed',
    );
  }
  const initialPreferredLocale = preferredLocaleResult.ok
    ? preferredLocaleResult.value
    : null;

  // Plans list for the dropdown
  const plansDeps = buildPlansDeps(tenant);
  const plansResult = await listPlans(
    { filter: { activeOnly: true } },
    {
      tenant: plansDeps.tenant,
      planRepo: plansDeps.planRepo,
      taxPolicy: plansDeps.taxPolicy,
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
    <FormContainer>
      <PageHeader
        title={t('title')}
        subtitle={member.companyName}
        actions={
          <Link
            href={`/admin/members/${memberId}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            <ArrowLeftIcon className="size-4" />
            {t('cancel')}
          </Link>
        }
      />
      {/* R4 Types-#6 (2026-05-02) — preferred-locale picker section.
          Card chrome + i18n title rendered inside the client component
          via useTranslations('admin.membersPreferredLocale').
          R5 UX-H1: server-seeds initialValue so admin sees current
          state and never silently overwrites with null on accidental Save. */}
      <AdminPreferredLocaleCard
        memberId={member.memberId}
        initialValue={initialPreferredLocale}
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
              notes: member.notes,
              addressLine1: member.addressLine1,
              addressLine2: member.addressLine2,
              city: member.city,
              province: member.province,
              postalCode: member.postalCode,
              // PR-B task 6 — แขวง/ตำบล.
              subDistrict: member.subDistrict,
              foundedYear: member.foundedYear,
              turnoverThb: member.turnoverThb,
              // PR-B task 7 — ทุนจดทะเบียน. A separate field from turnoverThb.
              registeredCapitalThb: member.registeredCapitalThb,
              // 088 US3 (FR-008) — §86/4 Head-Office / Branch particular.
              isHeadOffice: member.isHeadOffice ?? true,
              branchCode: member.branchCode ?? null,
              // 059 / PR-A — the RECORDED VAT-registrant flag gating them both.
              isVatRegistered: member.isVatRegistered,
              planId: member.planId,
              planYear: member.planYear,
              registrationDate: member.registrationDate
                .toISOString()
                .slice(0, 10),
            }}
            plans={plans}
            primaryContact={{
              contactId: primary?.contactId ?? '',
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
    </FormContainer>
  );
}
