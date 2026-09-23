/**
 * F7 US3 T134 — Member broadcast detail loading skeleton.
 *
 * Renders the real PageHeader + Back link (static i18n + static href,
 * no broadcast data needed) so chrome doesn't flash between skeleton
 * and final state. The body mirrors the settled page's THREE Card
 * sections — fields (subject + 4-item dl), the content read-back (a
 * heading + the 560 px preview frame) and the delivery breakdown
 * (6-stat grid) — using `SkeletonBlock` for reduced-motion-safe
 * shimmer and `PageSkeletonShell` for the single polite live region
 * (ux-standards.md § 2.1). Previously two generic full-width Skeleton
 * bars with no live region and no structural fidelity.
 *
 * T155 finding U1: the content card is the one T141 inserted BETWEEN the
 * other two, and this file was not updated with it — the delivery card
 * jumped ~640 px down on every settle. The frame height is imported from
 * `preview-frame-heights`, the same constant `page.tsx` hands
 * `PreviewSurface`, so the reservation cannot drift from the thing reserved.
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

export default async function BroadcastDetailLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Link
          href="/portal/benefits?tab=broadcasts"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('back')}
        </Link>
        {/* Fields card: heading + subject + 4-item dl grid. */}
        <Card>
          <CardContent className="flex flex-col gap-3">
            <SkeletonBlock className="h-5 w-24" />
            <SkeletonBlock className="h-5 w-2/3" />
            <div className="grid grid-cols-2 gap-3 pt-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-5 w-28" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        {/* Content card (T141): heading + the preview frame, reserved at the
            page's own DETAIL_PREVIEW_FRAME_HEIGHT so the delivery card below
            does not move when the document arrives. */}
        <Card>
          <CardHeader>
            <SkeletonBlock className="h-5 w-28" />
          </CardHeader>
          <CardContent>
            <SkeletonBlock
              data-testid="detail-content-frame-skeleton"
              className="w-full"
              style={{ height: DETAIL_PREVIEW_FRAME_HEIGHT }}
            />
          </CardContent>
        </Card>
        {/* Delivery breakdown card: heading + 6-stat grid (2-col, 3-col ≥sm). */}
        <Card>
          <CardContent className="flex flex-col gap-3">
            <SkeletonBlock className="h-5 w-40" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-8 w-16" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
