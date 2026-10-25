/**
 * The help page's loading frame: the real header and card titles, the bodies
 * skeletoned, in the page's own order (paused first, then contact).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.support');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start" aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card title={t('paused.title')} headingLevel={2}>
          <div className="flex flex-col gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-11/12" />
            <SkeletonBlock className="h-4 w-3/4" />
          </div>
        </Card>
        <Card title={t('contact.title')} headingLevel={2}>
          <div className="flex flex-col gap-[var(--aura-space-3)]">
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-11 w-48" />
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
