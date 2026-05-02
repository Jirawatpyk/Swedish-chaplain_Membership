/**
 * Admin /admin/broadcasts loading skeleton.
 *
 * Renders the real PageHeader (static i18n, no broadcast data needed)
 * + body skeletons. Header doesn't flash between skeleton and final
 * state.
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';

export default async function AdminBroadcastsLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue');
  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-12 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </TableContainer>
  );
}
