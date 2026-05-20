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
 */
export default async function Loading() {
  const t = await getTranslations('admin.broadcasts.templates');
  const tLayout = await getTranslations('layout');

  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader title={t('pageTitle')} subtitle={t('pageDescription')} />
        <div className="flex items-center justify-end mb-4">
          <SkeletonBlock className="h-9 w-32" />
        </div>
        <Card>
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
