import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * F7 US3 — /portal/benefits/e-blasts loading skeleton.
 *
 * Mirrors the settled page: real translated PageHeader (title +
 * subtitle) + a card-shaped QuotaDisplay placeholder + the history
 * table (5 columns × 10 rows = PER_PAGE) wrapped in a <Card> so the
 * skeleton matches the real surface pixel-for-pixel. Uses
 * `SkeletonBlock` (shared `.skeleton-shimmer`, reduced-motion safe)
 * and `PageSkeletonShell` for the single polite live region per
 * ux-standards.md § 2.1 — previously raw <Skeleton> blocks with no
 * live region and lower fidelity.
 */
export default async function EblastsListLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        {/* QuotaDisplay card placeholder — matches the real card radius. */}
        <SkeletonBlock className="h-32 w-full rounded-[var(--card-radius)]" />
        {/* History table: 5 columns (subject, status, audience, submitted,
            sent) × 10 rows (PER_PAGE) inside a Card — same idiom as
            /portal/invoices/loading.tsx. */}
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-5 gap-3">
              {Array.from({ length: 5 }).map((_, c) => (
                <SkeletonBlock key={c} className="h-4 w-20" />
              ))}
            </div>
            {Array.from({ length: 10 }).map((_, r) => (
              <div key={r} className="grid grid-cols-5 gap-3">
                {Array.from({ length: 5 }).map((_, c) => (
                  <SkeletonBlock key={c} className="h-8 w-full" />
                ))}
              </div>
            ))}
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
