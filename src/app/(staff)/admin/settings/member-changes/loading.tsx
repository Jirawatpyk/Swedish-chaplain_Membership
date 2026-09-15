import { getTranslations } from 'next-intl/server';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
 */
export default async function Loading() {
  const t = await getTranslations('admin.settings.memberChanges');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <Card>
          <CardHeader>
            <CardTitle>{t('title')}</CardTitle>
            <CardDescription>{t('cardDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4">
              {/* Switch + label/description block — mirrors the control anatomy. */}
              <div className="flex items-start gap-3">
                <SkeletonBlock className="mt-0.5 h-[18px] w-8 shrink-0 rounded-full" />
                <div className="grid w-full gap-2">
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
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
