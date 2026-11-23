import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * PR B — real PageHeader + Card title from i18n; only the two fields, the
 * note and the button pulse (ux-standards § 2).
 */
export default async function Loading() {
  const t = await getTranslations('admin.settings.renewalReplyTo');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start" aria-busy="true">
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <Card title={t('title')} description={t('cardDescription')} headingLevel={2}>
          <div aria-hidden className="grid gap-[var(--aura-space-4)]">
            {[0, 1].map((i) => (
              <div key={i} className="grid gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-10 w-full" />
                <SkeletonBlock className="h-3 w-3/4" />
              </div>
            ))}
            <SkeletonBlock className="h-16 w-full" />
            <SkeletonBlock className="h-10 w-28" />
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
