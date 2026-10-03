import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * T080 — /admin/invoices/[invoiceId]/credit-notes/new loading skeleton, on
 * AURA (spec 122 US8b, T827; board `Admin-credit-note`): the card with the
 * invoice summary and the three fields (amount, reason, typed confirm), then
 * the button row.
 */
export default async function Loading() {
  const t = await getTranslations('admin.creditNotes.new');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start">
        {/* The back link above the title (from 1024px; below, the shell's). */}
        <SkeletonBlock className="h-5 w-32 self-start max-lg:hidden" />
        <PageHeader title={t('title')} subtitle={t('description')} />
        <div className="flex flex-col gap-[var(--aura-space-5)]" aria-hidden="true">
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-5)]">
              <SkeletonBlock className="h-16 w-full" />
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
              </div>
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-24" />
                <SkeletonBlock className="h-20 w-full" />
              </div>
              <div className="flex flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-48" />
                <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
              </div>
            </div>
          </Card>
          <div className="flex justify-end gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-11 w-24" />
            <SkeletonBlock className="h-11 w-36" />
          </div>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
