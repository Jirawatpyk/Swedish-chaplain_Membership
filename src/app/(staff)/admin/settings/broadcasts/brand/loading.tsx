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
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * F119 T028 — skeleton for the Brand page.
 *
 * Mirrors `/admin/settings/broadcasts/loading.tsx`: the real PageHeader and
 * the real card titles render from i18n (they do not depend on the read, so
 * skeletoning them only buys a title flicker on navigation); only the three
 * interactive regions are stubbed, in the same anatomy and the same order as
 * `<BrandSettingsForm />` — colour field + swatch + readout, textarea +
 * counter, logo preview + source + link — so the skeleton→content swap does
 * not shift layout.
 */
export default async function Loading() {
  const t = await getTranslations('admin.settings.broadcasts.brand');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('colour.heading')}</CardTitle>
              <CardDescription>{t('colour.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <SkeletonBlock className="h-4 w-28" />
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <SkeletonBlock className="h-[var(--input-height)] sm:w-40" />
                  <SkeletonBlock className="h-9 w-14 shrink-0" />
                </div>
                <SkeletonBlock className="h-3 w-2/3" />
              </div>
              {/* Contrast readout. */}
              <SkeletonBlock className="h-4 w-56" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('address.heading')}</CardTitle>
              <CardDescription>{t('address.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <SkeletonBlock className="h-4 w-44" />
              <SkeletonBlock className="h-24 w-full" />
              <SkeletonBlock className="h-3 w-32" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('logo.heading')}</CardTitle>
              <CardDescription>{t('logo.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <SkeletonBlock className="h-16 w-40" />
              <SkeletonBlock className="h-3 w-40" />
              <SkeletonBlock className="h-3 w-28" />
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <SkeletonBlock className="h-9 w-40" />
          </div>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
