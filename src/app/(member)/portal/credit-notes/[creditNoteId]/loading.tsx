import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/** /portal/credit-notes/[creditNoteId] loading skeleton. */
export default async function Loading() {
  const t = await getTranslations('portal.creditNotes.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={<SkeletonBlock className="h-8 w-48" />}
          subtitle={t('subtitle')}
          actions={
            <div className="flex gap-2">
              <SkeletonBlock className="h-9 w-36" />
              <SkeletonBlock className="h-9 w-32" />
            </div>
          }
        />
        <Card>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-4 w-56" />
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-4 w-28" />
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-5 w-28" />
              <SkeletonBlock className="h-5 w-36" />
            </div>
            <SkeletonBlock className="mt-4 h-px w-full" />
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-3/4" />
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
