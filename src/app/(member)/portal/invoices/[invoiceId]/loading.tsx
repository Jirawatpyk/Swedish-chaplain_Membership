import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * T072 polish — `/portal/invoices/[invoiceId]` loading skeleton.
 *
 * Mirrors the detail page sections: meta grid (4 fields), 3 line
 * rows, totals trio. Real translated title/subtitle to match the
 * settled page header — same convention as the list-loading skeleton.
 * Uses DetailContainer (72rem) to match the page; mismatched
 * containers would trigger `pnpm check:layout` (FR-007 CLS-0).
 */
export default async function Loading() {
  const t = await getTranslations('portal.invoices.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2">
                <SkeletonBlock className="h-3 w-24" />
                <SkeletonBlock className="h-5 w-32" />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-3">
            <SkeletonBlock className="h-5 w-32" />
            {Array.from({ length: 3 }).map((_, r) => (
              <div key={r} className="grid grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, c) => (
                  <SkeletonBlock key={c} className="h-8 w-full" />
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid gap-2 sm:grid-cols-2 sm:justify-items-end">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="contents">
                <SkeletonBlock className="h-3 w-20" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            ))}
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
