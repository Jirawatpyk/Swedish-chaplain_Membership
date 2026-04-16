import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PencilIcon, UserPlusIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { getMember } from '@/modules/members';

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

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // Resolve member from linked user
  const memberResult = await deps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-muted-foreground">{t('notLinked')}</p>
      </div>
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
      <div className="py-12 text-center">
        <p className="text-body text-muted-foreground">{t('loadError')}</p>
      </div>
    );
  }

  const { member: m, contacts } = result.value;
  const activeContacts = contacts.filter((c) => !c.removedAt);
  const primaryContact = activeContacts.find((c) => c.isPrimary);
  const secondaryContacts = activeContacts.filter((c) => !c.isPrimary);
  const isPrimary = String(primaryContact?.linkedUserId) === user.id;

  return (
    <>
      <PageHeader
        title={t('pageTitle')}
        subtitle={m.companyName}
        actions={
          <Link href="/portal/edit" className={buttonVariants({ size: 'sm' })}>
            <PencilIcon className="mr-1.5 size-4" aria-hidden />
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
              <dd className="text-body">{m.country}</dd>
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
                {t('fields.planYear')}
              </dt>
              <dd className="text-body font-medium">{m.planYear}</dd>
            </div>
            <div>
              <dt className="text-caption text-muted-foreground">
                {t('fields.registrationDate')}
              </dt>
              <dd className="text-body">
                {m.registrationDate.toISOString().split('T')[0]}
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
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <UserPlusIcon className="mr-1.5 size-4" aria-hidden />
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
    </>
  );
}
