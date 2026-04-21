import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/** /admin/credit-notes directory loading skeleton. */
export default async function Loading() {
  const t = await getTranslations('admin.creditNotes.list');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('description')} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <SkeletonBlock className="h-9 w-64" />
              <SkeletonBlock className="h-9 w-24" />
              <SkeletonBlock className="h-9 w-20" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-12 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
