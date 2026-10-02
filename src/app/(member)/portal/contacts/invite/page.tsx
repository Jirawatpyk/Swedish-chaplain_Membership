import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { InviteColleagueForm } from '@/components/members/invite-colleague-form';
import { BackLink } from '@/components/portal/back-link';
import { env } from '@/lib/env';

/**
 * Portal colleague invite page — US5 AS4 (T125).
 *
 * Only accessible to the primary contact of the member. Non-primary
 * contacts see a "not authorized" message (enforced server-side too).
 *
 * Spec 122 US3 (`Portal-contacts-invite`): the portal column with a
 * "← Back to profile" link over the title and the form in a 720px column.
 */
function InviteFrame({ back, children }: { readonly back: string; readonly children: React.ReactNode }) {
  return (
    // The board's 720px column, centred like the edit page's (back link,
    // header and form together).
    <DetailContainer className="max-w-[calc(45rem+2*var(--page-padding-x))]">
      <BackLink href="/portal/profile">{back}</BackLink>
      {children}
    </DetailContainer>
  );
}
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invite');
  return { title: t('pageTitle') };
}

export default async function PortalInvitePage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invite');
  const tHistory = await getTranslations('portal.changeRequests.history');

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // Resolve member from linked user
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    return (
      <InviteFrame back={tHistory('backToProfile')}>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-[var(--aura-fg-secondary)]">{t('notLinked')}</p>
        </div>
      </InviteFrame>
    );
  }

  const member = memberResult.value;

  // Check if user is primary contact
  const contactsResult = await deps.contactRepo.listByMember(tenant, member.memberId);
  if (!contactsResult.ok) {
    return (
      <InviteFrame back={tHistory('backToProfile')}>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-[var(--aura-fg-secondary)]">{t('loadError')}</p>
        </div>
      </InviteFrame>
    );
  }

  const ownContact = contactsResult.value.find(
    (c) => String(c.linkedUserId) === user.id && !c.removedAt,
  );
  if (!ownContact?.isPrimary) {
    return (
      <InviteFrame back={tHistory('backToProfile')}>
        <PageHeader title={t('pageTitle')} />
        <div className="py-12 text-center">
          <p className="text-body text-[var(--aura-fg-secondary)]">{t('notPrimary')}</p>
        </div>
      </InviteFrame>
    );
  }

  return (
    <InviteFrame back={tHistory('backToProfile')}>
      <PageHeader title={t('pageTitle')} subtitle={member.companyName} />
      <InviteColleagueForm privacyNoticeHref={env.broadcasts.privacyPolicyUrl ?? null} />
    </InviteFrame>
  );
}
