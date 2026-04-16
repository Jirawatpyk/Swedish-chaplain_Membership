import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';

/**
 * Portal colleague invite page — US5 AS4 (T125).
 *
 * Only accessible to the primary contact of the member. Non-primary
 * contacts see a "not authorized" message (enforced server-side too).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invite');
  return { title: t('pageTitle') };
}

export default async function PortalInvitePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invite');

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

  // Check if user is primary contact
  const contactsResult = await deps.contactRepo.listByMember(
    tenant,
    member.memberId,
  );
  if (!contactsResult.ok) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-muted-foreground">{t('loadError')}</p>
      </div>
    );
  }

  const ownContact = contactsResult.value.find(
    (c) => String(c.linkedUserId) === user.id && !c.removedAt,
  );
  if (!ownContact?.isPrimary) {
    return (
      <div className="py-12 text-center">
        <p className="text-body text-muted-foreground">{t('notPrimary')}</p>
      </div>
    );
  }

  return (
    <>
      <PageHeader title={t('pageTitle')} subtitle={member.companyName} />
      <InviteColleagueForm />
    </>
  );
}
