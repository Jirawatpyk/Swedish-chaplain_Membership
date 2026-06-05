import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations, getFormatter } from 'next-intl/server';
import { BookUserIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { CopyButton } from '@/components/members/copy-button';
import { CountryDisplay } from '@/components/members/country-display';
import { requireSession } from '@/lib/auth-session';
import { runInTenant } from '@/lib/db';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { getMember, formatMemberNumber, asMemberNumber } from '@/modules/members';
import type { TenantId } from '@/modules/members';
import { env } from '@/lib/env';

/**
 * Portal profile view — US5 AS1 (T123).
 *
 * Displays the member's company info, plan, and contact list.
 * Admin-only fields (notes, override reasons) are omitted.
 * Tabs that depend on F4/F5/F6/F7 are hidden entirely (not disabled).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.profile');
  return { title: t('pageTitle') };
}

export default async function PortalProfilePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.profile');
  const tDir = await getTranslations('directorySettings');

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // Resolve member from linked user
  const memberResult = await deps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('notLinked')}</p>
        </div>
      </DetailContainer>
    );
  }

  const member = memberResult.value;
  const result = await getMember(
    member.memberId,
    { actorUserId: user.id, requestId: 'portal-profile' },
    {
      tenant,
      memberRepo: deps.memberRepo,
      contactRepo: deps.contactRepo,
      audit: deps.audit,
    },
  );

  if (!result.ok) {
    return (
      <DetailContainer>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('loadError')}</p>
        </div>
      </DetailContainer>
    );
  }

  const { member: m, contacts } = result.value;
  const activeContacts = contacts.filter((c) => !c.removedAt);
  // Find the caller's own contact and check if THEY are primary
  const ownContact = activeContacts.find(
    (c) => String(c.linkedUserId) === user.id,
  );
  const isPrimary = ownContact?.isPrimary === true;
  const format = await getFormatter();

  // B24 — resolve the plan/tier display name via the existing PlanLookupPort
  // dep (mirrors admin/members/[memberId]/page.tsx). Falls back to the plan
  // slug if the row is missing/inactive (defensive against data drift).
  const planLookup = await deps.plans.getPlan(tenant, m.planId, m.planYear);
  const planDisplayName = planLookup.ok ? planLookup.value.planNameEn : m.planId;

  // 055-member-number — resolve per-tenant prefix via read-only runInTenant
  // (Plan corrections §2: never raw db — RLS-bypass gotcha).
  const memberPrefix = await runInTenant(tenant, (tx) =>
    deps.memberSettings.getPrefix(tx, tenant.slug as TenantId),
  );
  const memberNumberFormatted = formatMemberNumber(memberPrefix, asMemberNumber(m.memberNumber));

  return (
    <DetailContainer>
      <PageHeader
        title={t('pageTitle')}
        subtitle={m.companyName}
        actions={
          <Link href="/portal/edit" className={buttonVariants()}>
            <PencilIcon className="size-4" aria-hidden />
            {t('editButton')}
          </Link>
        }
      />

      {/* Company Info */}
        <Card>
        <CardHeader>
          <CardTitle>{t('companySection')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {/* 055-member-number — human-readable member number displayed ABOVE
                the UUID so callers can quote it to support without needing a
                copy of the raw UUID (design §8.3 portal affordance). */}
            <div className="lg:col-span-3">
              <dt className="text-caption text-muted-foreground">
                {t('fields.memberNumber')}
              </dt>
              <dd className="text-body flex items-center gap-2">
                <span className="font-mono text-sm font-medium">
                  {memberNumberFormatted}
                </span>
                <CopyButton
                  value={memberNumberFormatted}
                  label={t('fields.memberNumberCopy')}
                />
              </dd>
            </div>
            {/* I6 round-10 ui-design-specialist — surface member_id +
                copy-to-clipboard. Support staff first question when a
                member calls is "what's your member ID?"; the admin
                detail page already had this affordance, the portal
                side was the gap. `font-mono text-xs` to mirror admin
                styling; `lg:col-span-3` so the row spans the full
                grid above the rest of the fields. */}
            <div className="lg:col-span-3">
              <dt className="text-caption text-muted-foreground">
                {t('fields.memberId')}
              </dt>
              <dd className="text-body flex items-center gap-2">
                <span className="font-mono text-xs">{m.memberId}</span>
                <CopyButton
                  value={m.memberId}
                  label={t('fields.memberIdCopy')}
                />
                <span className="text-caption text-muted-foreground">
                  {t('fields.memberIdHelp')}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.companyName')}
              </dt>
              <dd className="text-body font-medium">{m.companyName}</dd>
            </div>
            {m.legalEntityType && (
              <div>
                <dt className="text-caption text-muted-foreground">
                  {t('fields.legalEntityType')}
                </dt>
                <dd className="text-body">{m.legalEntityType}</dd>
              </div>
            )}
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.country')}
              </dt>
              <dd className="text-body">
                <CountryDisplay code={m.country} />
              </dd>
            </div>
            {m.website && (
              <div>
                <dt className="text-caption text-muted-foreground">
                  {t('fields.website')}
                </dt>
                <dd className="text-body">
                  <a
                    href={m.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    {m.website}
                  </a>
                </dd>
              </div>
            )}
            {m.description && (
              <div className="sm:col-span-2 lg:col-span-3">
                <dt className="text-caption text-muted-foreground">
                  {t('fields.description')}
                </dt>
                <dd className="text-body">{m.description}</dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      {/* Plan */}
      <Card>
        <CardHeader>
          <CardTitle>{t('planSection')}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.planName')}
              </dt>
              <dd className="text-body font-medium">{planDisplayName}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.planYear')}
              </dt>
              <dd className="text-body font-medium">{m.planYear}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.registrationDate')}
              </dt>
              <dd className="text-body">
                {format.dateTime(m.registrationDate, { dateStyle: 'medium' })}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.status')}
              </dt>
              <dd>
                <Badge
                  variant={m.status === 'active' ? 'default' : 'secondary'}
                >
                  {t(`status.${m.status}`)}
                </Badge>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Contacts */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('contactsSection')}</CardTitle>
          {isPrimary && (
            <Link
              href="/portal/contacts/invite"
              className={buttonVariants({ variant: 'outline' })}
            >
              <UserPlusIcon className="size-4" aria-hidden />
              {t('inviteColleague')}
            </Link>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {activeContacts.map((contact) => (
              <div
                key={contact.contactId}
                className="flex items-start justify-between rounded-lg border p-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-body font-medium">
                      {contact.firstName} {contact.lastName}
                    </p>
                    {contact.isPrimary && (
                      <Badge variant="secondary">{t('primaryBadge')}</Badge>
                    )}
                    {contact.linkedUserId && (
                      <Badge variant="outline">{t('portalLinked')}</Badge>
                    )}
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {contact.email}
                  </p>
                  {contact.phone && (
                    <p className="text-caption text-muted-foreground">
                      {contact.phone}
                    </p>
                  )}
                  {contact.roleTitle && (
                    <p className="text-caption text-muted-foreground">
                      {contact.roleTitle}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {activeContacts.length === 0 && (
              <p className="text-body text-muted-foreground">
                {t('noContacts')}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* F9 US5 — directory listing self-service (FR-025). Gated on the F9 flag
          so it stays hidden until the feature flips on; the target page itself
          notFounds when dark. Keeps the member's directory settings discoverable
          "under /portal/profile" per the IA. */}
      {env.features.f9Dashboard ? (
        <Card>
          <CardHeader>
            <CardTitle>{tDir('title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-body text-muted-foreground">{tDir('subtitle')}</p>
            <Link
              href="/portal/profile/directory"
              className={buttonVariants({ variant: 'outline' })}
            >
              <BookUserIcon className="size-4" aria-hidden />
              {tDir('manage')}
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </DetailContainer>
  );
}
