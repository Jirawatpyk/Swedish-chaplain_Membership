/**
 * Route-level loading UI for /portal/profile/directory — AURA card skeletons
 * in the final shape (spec 122 US3, `Portal-directory`): the back link and
 * header, then the Logo and Listing cards with the preview beside them from
 * 1024px.
 */
import { getTranslations } from 'next-intl/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const FIELD_ROWS = Array.from({ length: 9 }, (_, i) => i);

function CardSkeleton({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="aura-card" aria-hidden>
      <div className="aura-card__head">
        <SkeletonBlock className="h-5 w-40" />
      </div>
      <div className="aura-card__body flex flex-col gap-3">{children}</div>
    </div>
  );
}

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('directorySettings');
  return (
    <DetailContainer>
      <SkeletonBlock className="h-5 w-32" />
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <CardSkeleton>
            <div className="flex items-center gap-5">
              <SkeletonBlock className="size-24 shrink-0 max-sm:size-[72px]" />
              <div className="flex flex-1 flex-col gap-3">
                <SkeletonBlock className="h-4 w-full max-w-sm" />
                <SkeletonBlock className="h-11 w-40" />
              </div>
            </div>
          </CardSkeleton>

          <CardSkeleton>
            <SkeletonBlock className="h-14 w-full" />
            <div className="grid gap-x-4 gap-y-2.5 sm:grid-cols-2">
              {FIELD_ROWS.map((i) => (
                <SkeletonBlock key={i} className="h-5 w-full max-w-xs" />
              ))}
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <SkeletonBlock className="h-11 w-full" />
              <SkeletonBlock className="h-11 w-full" />
              <SkeletonBlock className="h-20 w-full sm:col-span-2" />
              <SkeletonBlock className="h-11 w-full" />
              <SkeletonBlock className="h-11 w-full" />
            </div>
            <SkeletonBlock className="h-11 w-32 self-end" />
          </CardSkeleton>
        </div>

        <div className="flex flex-col gap-2.5" aria-hidden>
          <SkeletonBlock className="h-4 w-40" />
          <div className="aura-card">
            <div className="aura-card__body flex flex-col gap-3">
              <SkeletonBlock className="h-14 w-full" />
              <SkeletonBlock className="h-12 w-full" />
              <SkeletonBlock className="h-4 w-3/4" />
            </div>
          </div>
        </div>
      </div>
    </DetailContainer>
  );
}
