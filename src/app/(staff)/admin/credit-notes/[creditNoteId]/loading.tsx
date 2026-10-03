import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * /admin/credit-notes/[creditNoteId] loading skeleton.
 *
 * Spec 122 US8c (T845) — the `Admin-credit-note-detail` shape on AURA, for
 * CLS 0: the title with Resend email and Download PDF, the Details card (four
 * fields, then the amounts at its end), the Reason card and the Parties card.
 */
export default async function Loading() {
  const t = await getTranslations('admin.creditNotes.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={<SkeletonBlock className="h-8 w-72 max-w-full" />}
          subtitle={t('subtitle')}
          actions={
            <>
              <SkeletonBlock className="h-[var(--aura-button-height)] w-36" />
              <SkeletonBlock className="h-[var(--aura-button-height)] w-36" />
            </>
          }
        />
        <Card header={<SkeletonBlock className="h-6 w-24" />}>
          <div className="flex flex-col gap-[var(--aura-space-6)]">
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-5 w-40 max-w-full" />
                </div>
              ))}
            </div>
            <div className="ms-auto flex w-full flex-col gap-2 sm:max-w-sm">
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="h-4 w-full" />
              <SkeletonBlock className="h-6 w-full" />
            </div>
          </div>
        </Card>
        <Card header={<SkeletonBlock className="h-6 w-20" />}>
          <SkeletonBlock className="h-4 w-3/4" />
        </Card>
        <Card header={<SkeletonBlock className="h-6 w-24" />}>
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-3">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="h-4 w-48" />
                <SkeletonBlock className="h-4 w-32" />
                <SkeletonBlock className="h-4 w-64 max-w-full" />
              </div>
            ))}
          </div>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
