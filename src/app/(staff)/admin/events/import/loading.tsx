/**
 * T098 — /admin/events/import skeleton (F6 Phase 7).
 *
 * Spec 122 US9b-2 (T938): the real page's shape on AURA for CLS 0 — the
 * header (real title and subtitle), then the form card: the event field
 * with its hint and the create/refresh row, the upload field with its
 * hint. Renders inside FormContainer (as the page), so `pnpm check:layout` accepts the
 * container pair.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function CsvImportLoading() {
  const t = await getTranslations('admin.events.import');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start" aria-busy="true">
        <PageHeader title={t('pageTitle')} subtitle={t('pageSubtitle')} />
        <Card aria-hidden>
          <div className="flex flex-col gap-[var(--aura-space-6)]">
            <div className="flex flex-col gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-6 w-40" />
              <SkeletonBlock className="h-4 w-72 max-w-full" />
            </div>
            <div className="flex flex-col gap-[var(--aura-space-2)]" data-skeleton="event-field">
              <SkeletonBlock className="h-4 w-16" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full max-sm:h-11" />
              <SkeletonBlock className="h-3 w-96 max-w-full" />
              <div className="flex flex-row gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-8 w-40 max-sm:h-11" />
                <SkeletonBlock className="h-8 w-8 max-sm:size-11" />
              </div>
            </div>
            <div className="flex flex-col gap-[var(--aura-space-2)]" data-skeleton="upload">
              <SkeletonBlock className="h-4 w-32" />
              <SkeletonBlock className="h-28 w-full" />
              <SkeletonBlock className="h-3 w-80 max-w-full" />
            </div>
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
