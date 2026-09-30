import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card } from '@jirawatpyk/aura-react/server';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Portal profile loading skeleton — matches the shape of
 * `/portal/profile/page.tsx` (Organisation + Membership + Contacts), whose
 * sections are AURA Cards titled with an h2: the skeleton uses the same Card
 * and title, so its headings and outline match the loaded page.
 * Wraps in DetailContainer (72rem) to mirror the real page.
 */
export default async function Loading() {
  const t = await getTranslations('portal.profile');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={t('pageTitle')}
          subtitle={<SkeletonBlock className="h-4 w-48" />}
          actions={<SkeletonBlock className="h-9 w-28" />}
        />
        {/* Organisation */}
        <Card as="div" title={t('organisationSection')} headingLevel={2}>
          <div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* Membership */}
        <Card as="div" title={t('membershipSection')} headingLevel={2}>
          <div>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-32" />
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* Contacts */}
        {/* The Invite Colleague action (visible only when the caller is
            primary — optimistic render of the skeleton so layout stays stable). */}
        <Card as="div" title={t('contactsSection')} headingLevel={2} actions={<SkeletonBlock className="h-9 w-36" />}>
          <div>
            <div className="space-y-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between rounded-lg border p-4"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <SkeletonBlock className="h-4 w-40" />
                    <SkeletonBlock className="h-3 w-56" />
                    <SkeletonBlock className="h-3 w-32" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
