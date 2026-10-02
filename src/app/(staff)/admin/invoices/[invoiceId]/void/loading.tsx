import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * T102 — /admin/invoices/[invoiceId]/void loading skeleton, on AURA (spec
 * 122 US8b, T827; board `Admin-void`): the warning, then the card with the
 * reason (and its helper line, UX-6) and the typed confirmation, then the
 * button row — stacked full width below 640px with Void on top, as the page.
 */
export default async function Loading() {
  const t = await getTranslations('admin.invoices.void');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('title')} subtitle={t('description')} />
        <div className="flex flex-col gap-[var(--aura-space-5)]" aria-hidden="true">
          <SkeletonBlock className="h-16 w-full" />
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-5)]">
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-20 w-full" />
                <SkeletonBlock className="h-3 w-40" />
              </div>
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-48" />
                <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
              </div>
            </div>
          </Card>
          <div className="flex justify-end gap-[var(--aura-space-2)] max-sm:flex-col">
            <SkeletonBlock className="h-11 w-32 max-sm:w-full" />
            <SkeletonBlock className="h-11 w-24 max-sm:w-full" />
          </div>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
