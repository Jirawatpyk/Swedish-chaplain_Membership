/**
 * Route-level loading UI for /admin/marketing/audience — shimmer skeleton in
 * the final table shape (ux-standards § 2.1, CLS 0). `TableContainer` here
 * AND in page.tsx (check:layout). `aria-busy` on the container follows the
 * loading-file convention (a11y review 9); the skeleton defaults to the
 * 8-column shape (admin / super_admin / marketing — the common case) and the
 * preset action is sized for the REAL button, which wraps to two lines in SV.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { AudienceFiltersSkeleton, AudienceTableSkeleton } from './_components/audience-table-skeleton';

export default async function Loading() {
  const t = await getTranslations('admin.marketing.audience');
  return (
    <TableContainer aria-busy="true">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<SkeletonBlock className="h-11 w-72 sm:h-9" />}
      />
      <Card>
        <div className="flex flex-col gap-4">
          <AudienceFiltersSkeleton />
          <AudienceTableSkeleton />
        </div>
      </Card>
    </TableContainer>
  );
}
