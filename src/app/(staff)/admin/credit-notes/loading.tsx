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
          <CardContent className="flex flex-col gap-6">
            {/* Filter bar — mirror real form: grow-to-fit search +
              * fiscal-year input + Apply/Clear buttons. Match labels
              * above each input so height reserved prevents CLS. */}
            <div className="flex w-full flex-wrap items-end gap-3">
              <div className="grid flex-1 gap-1 min-w-[10rem]">
                <SkeletonBlock className="h-3 w-24" />
                <SkeletonBlock className="h-9 w-full" />
              </div>
              <div className="grid gap-1">
                <SkeletonBlock className="h-3 w-16" />
                <SkeletonBlock className="h-9 w-24" />
              </div>
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
