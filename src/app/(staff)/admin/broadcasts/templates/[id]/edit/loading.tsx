import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.broadcasts.templates');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader
          title={t('editPageTitle')}
          subtitle={t('editPageDescription')}
        />
        {/* The card's title is the template's name, so it is a block here
            (a block inside a heading would not be valid markup). */}
        <Card>
          <div className="flex flex-col gap-[var(--aura-space-6)]">
            <div className="flex flex-col gap-1">
              <SkeletonBlock className="h-6 w-1/2" />
              <p className="aura-text-body text-[var(--aura-fg-secondary)]">{t('editPageDescription')}</p>
            </div>
            <div className="space-y-6">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <SkeletonBlock className="h-4 w-32" />
                  <SkeletonBlock className="h-[var(--input-height)] w-full" />
                  <SkeletonBlock className="h-3 w-2/3" />
                </div>
              ))}
              <div className="flex items-center justify-end gap-3">
                <SkeletonBlock className="h-9 w-20" />
                <SkeletonBlock className="h-9 w-28" />
              </div>
            </div>
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
