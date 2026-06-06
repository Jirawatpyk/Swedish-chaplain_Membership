import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Portal profile loading skeleton — matches the shape of
 * `/portal/profile/page.tsx` (Organisation + Membership + Contacts).
 * Wraps in DetailContainer (72rem) to mirror the real page.
 *
 * Section titles render as real `<h2>` (NOT CardTitle, which is a `<div>`) so
 * the skeleton's heading semantics match the loaded page's `SectionHeading`
 * (057 review F10) — same font classes, identical visual.
 */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-heading text-base font-medium leading-snug">
      {children}
    </h2>
  );
}
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
        <Card>
          <CardHeader>
            <SectionHeading>{t('organisationSection')}</SectionHeading>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-40" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Membership */}
        <Card>
          <CardHeader>
            <SectionHeading>{t('membershipSection')}</SectionHeading>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-32" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Contacts */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <SectionHeading>{t('contactsSection')}</SectionHeading>
            {/* Invite Colleague button (visible only when caller is primary —
                optimistic render of the skeleton so layout stays stable). */}
            <SkeletonBlock className="h-9 w-36" />
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
