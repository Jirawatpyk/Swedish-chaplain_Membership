import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  Card,
  CardContent,
} from '@/components/ui/card';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Mirrors `/admin/broadcasts/loading.tsx` convention — real PageHeader
 * + Card chrome from i18n; skeleton only the interactive table rows
 * to avoid title flicker on navigation (per Round-3-Final Phase H7).
 *
 * U12 (#400 PR-B) — matches `page.tsx` + `AdminTemplateLibrary`: the New
 * template button sits in the PageHeader's actions (the skeleton used to draw a
 * separate button row the page does not have), then the three filter pills
 * (default `h-9` buttons, which it omitted), then the full-bleed table card.
 */
export default async function Loading() {
  const t = await getTranslations('admin.broadcasts.templates');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('pageTitle')}
          subtitle={t('pageDescription')}
          actions={<SkeletonBlock className="h-9 w-32" />}
        />
        {/* The All / Starter / Admin-authored filter pills. */}
        <div className="flex flex-wrap items-center gap-2">
          <SkeletonBlock data-skeleton="template-filter-pill" className="h-9 w-12" />
          <SkeletonBlock data-skeleton="template-filter-pill" className="h-9 w-20" />
          <SkeletonBlock data-skeleton="template-filter-pill" className="h-9 w-32" />
        </div>
        <Card className="py-0">
          <CardContent className="p-0">
            <div className="space-y-0">
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-4 p-3 border-b last:border-b-0"
                >
                  <SkeletonBlock className="h-4 w-1/3" />
                  <SkeletonBlock className="h-3 w-16" />
                  <SkeletonBlock className="h-8 w-16" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
