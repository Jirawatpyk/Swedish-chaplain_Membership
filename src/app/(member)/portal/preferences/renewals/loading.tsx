/**
 * `/portal/preferences/renewals` — loading skeleton.
 *
 * Mirrors the real page's `<FormContainer>` shell + `<header>` + a
 * single skeleton block for the renewal-reminders toggle row. Required
 * by `pnpm check:layout` (every migrated page.tsx must have a sibling
 * loading.tsx using the SAME container variant per FR-007 / 006-layout-
 * container-tier2).
 */
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.preferences.renewals');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader title={t('title')} subtitle={<SkeletonBlock className="h-4 w-72" />} />
        <Card>
          <CardContent className="flex flex-col gap-3">
            <SkeletonBlock className="h-6 w-1/2" />
            <SkeletonBlock className="h-10 w-40" />
          </CardContent>
        </Card>
      </FormContainer>
    </PageSkeletonShell>
  );
}
