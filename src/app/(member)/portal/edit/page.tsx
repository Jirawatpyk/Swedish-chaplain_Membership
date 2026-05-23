import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { PortalEditForm } from '@/components/members/portal-edit-form';

/**
 * Portal edit page — US5 AS2 (T124).
 *
 * Allows member to edit whitelisted fields only:
 *   - Contact: firstName, lastName, phone, preferredLanguage
 *   - Member: website, description
 *
 * FR-042: forbidden fields are hidden entirely (not shown disabled).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.edit');
  return { title: t('pageTitle') };
}

export default async function PortalEditPage() {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.edit');

  const tenant = resolveTenantFromRequest();
  const deps = buildMembersDeps(tenant);

  // Resolve member from linked user
  const memberResult = await deps.memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    // Distinguish a legitimate "no member linked" (repo.not_found → notLinked)
    // from a real DB/RLS failure (repo.unexpected). Without this split a
    // transient Neon error would tell the member they have no account AND
    // leave ops with no trace. Mirrors account/page.tsx.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { err: memberResult.error, tenantId: tenant.slug, userId: user.id },
        'portal.edit.member_lookup_failed',
      );
    }
    const message =
      memberResult.error.code === 'repo.not_found'
        ? t('notLinked')
        : t('loadError');
    return (
      <FormContainer>
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{message}</p>
        </div>
      </FormContainer>
    );
  }

  const member = memberResult.value;

  // Load contacts to find the caller's own contact
  const contactsResult = await deps.contactRepo.listByMember(
    tenant,
    member.memberId,
  );
  if (!contactsResult.ok) {
    if (contactsResult.error.code !== 'repo.not_found') {
      logger.error(
        { err: contactsResult.error, tenantId: tenant.slug, userId: user.id },
        'portal.edit.contacts_lookup_failed',
      );
    }
    return (
      <FormContainer>
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('loadError')}</p>
        </div>
      </FormContainer>
    );
  }

  const ownContact = contactsResult.value.find(
    (c) => String(c.linkedUserId) === user.id && !c.removedAt,
  );
  if (!ownContact) {
    return (
      <FormContainer>
        <div className="py-12 text-center">
          <p className="text-body text-muted-foreground">{t('notLinked')}</p>
        </div>
      </FormContainer>
    );
  }

  return (
    <FormContainer>
      <PageHeader title={t('pageTitle')} subtitle={member.companyName} />
      <PortalEditForm
        initialValues={{
          firstName: ownContact.firstName,
          lastName: ownContact.lastName,
          phone: ownContact.phone ?? '',
          preferredLanguage: ownContact.preferredLanguage,
          website: member.website ?? '',
          description: member.description ?? '',
        }}
      />
    </FormContainer>
  );
}
