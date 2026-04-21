import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * T102 — /admin/invoices/[invoiceId]/void loading skeleton.
 * Reserves the 2-field form shape (reason textarea, typed confirm).
 */
export default async function Loading() {
  const t = await getTranslations('admin.invoices.void');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('title')} subtitle={t('description')} />
        <Card>
          <CardContent className="flex flex-col gap-6">
            <SkeletonBlock className="h-14 w-full" />
            <div className="grid gap-2">
              <SkeletonBlock className="h-3 w-24" />
              <SkeletonBlock className="h-20 w-full" />
            </div>
            <div className="grid gap-2">
              <SkeletonBlock className="h-3 w-48" />
              <SkeletonBlock className="h-9 w-full" />
            </div>
            <div className="flex gap-2">
              <SkeletonBlock className="h-9 w-32" />
              <SkeletonBlock className="h-9 w-24" />
            </div>
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
