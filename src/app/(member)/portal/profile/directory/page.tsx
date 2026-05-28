/**
 * F9 US5 (T082b) — /portal/profile/directory (member's own directory listing).
 *
 * Member self-service control of their directory listing (FR-025): the listed
 * toggle, per-field visibility (email default-hidden), directory metadata, and
 * logo. The member is resolved from the session (`findByLinkedUserId`), never
 * the URL — `getDirectoryListing` + the mutation routes both enforce own-only.
 * Gated behind `FEATURE_F9_DASHBOARD` (notFound when dark).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { UserX } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { getDirectoryListing, makeUpdateDirectoryListingDeps } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { DirectoryVisibilityForm } from '@/components/directory/directory-visibility-form';
import { DirectoryLogoControl } from '@/components/directory/directory-logo-control';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('directorySettings');
  return { title: t('title') };
}

export default async function PortalDirectorySettingsPage(): Promise<React.JSX.Element> {
  const { user } = await requireSession('member');
  if (!env.features.f9Dashboard) notFound();

  const t = await getTranslations('directorySettings');
  const tenant = resolveTenantFromRequest();

  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(
    tenant,
    user.id,
  );
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        { errKind: errKind(memberResult.error) },
        'portal.directory.member_lookup_failed',
      );
      throw new Error('Failed to load member for directory settings');
    }
    return (
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
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

  const listingResult = await getDirectoryListing(
    { memberId: member.memberId },
    { actorRole: 'member', actorMemberId: member.memberId },
    tenant,
    makeUpdateDirectoryListingDeps(tenant.slug),
  );
  // forbidden is impossible (own member); treat any non-ok as "no listing yet".
  const listing = listingResult.ok ? listingResult.value : null;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <section aria-labelledby="dir-logo-heading" className="space-y-3">
        <h2 id="dir-logo-heading" className="text-sm font-semibold">
          {t('logoHeading')}
        </h2>
        <DirectoryLogoControl currentLogoUrl={listing?.logoUrl ?? null} />
      </section>

      <DirectoryVisibilityForm
        initial={{
          listed: listing?.listed ?? false,
          fieldVisibility: listing?.fieldVisibility ?? {},
          industry: listing?.industry ?? null,
          description: listing?.description ?? null,
          website: listing?.website ?? null,
          locationCity: listing?.locationCity ?? null,
          locationCountry: listing?.locationCountry ?? null,
        }}
      />
    </DetailContainer>
  );
}
