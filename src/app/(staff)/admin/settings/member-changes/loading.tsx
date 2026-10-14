import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Mirrors `/admin/settings/broadcasts/loading.tsx` — real PageHeader +
 * Card title/description from i18n; skeleton only the switch row and the
 * state line, so nothing but the interactive part shimmers (ux-standards
 * § 2.1). The description block reserves FOUR lines — the SV copy wraps to
 * four at the form width, and under-reserving shifts the state line on swap
 * (UX M4).
 *
 * Spec 122 US10c (T1024): the AURA card and the AURA pulse skeleton.
 */
export default async function Loading() {
  const t = await getTranslations('admin.settings.memberChanges');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer align="start" aria-busy="true">
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <Card title={t('title')} description={t('cardDescription')} headingLevel={2}>
          <div aria-hidden className="grid gap-[var(--aura-space-4)]">
            {/* Switch + label/description block — mirrors AURA's switch row. */}
            <div className="flex items-start gap-[var(--aura-space-3)]">
              <SkeletonBlock className="mt-0.5 h-5 w-9 shrink-0 rounded-full" />
              <div className="grid w-full gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-56 max-w-full" />
                <SkeletonBlock className="h-3 w-full" />
                <SkeletonBlock className="h-3 w-full" />
                <SkeletonBlock className="h-3 w-full" />
                <SkeletonBlock className="h-3 w-3/4" />
              </div>
            </div>
            {/* State line */}
            <SkeletonBlock className="h-4 w-2/3" />
          </div>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
