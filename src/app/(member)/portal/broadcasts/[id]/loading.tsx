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
 *
 * F119 T086 — the page became the sign-off view: a stage banner above the
 * fields card, and the content is a compare grid (the formatted version
 * first, the member's original beside it at ≥ lg). The skeleton cannot know
 * the stage, so it reserves the sign-off shape above the fold — banner,
 * fields, the first frame (and the second beside it on a wide screen) — and
 * leaves the stage-dependent sections below (decision controls, history) to
 * arrive under the fold.
 *
 * T086a V5 — it still reserved the delivery card, which the page renders only
 * once sending has begun (`DELIVERY_STATUSES`); on the sign-off stages the
 * decision controls and the history sit in that slot, so it was the wrong
 * card. It is no longer reserved: the stage-dependent sections below the
 * compare grid all arrive under the fold. And the fields card now has the
 * page's `CardHeader` (the "Subject" overline over the subject heading); the
 * skeleton drew both bars inside its content.
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

export default async function BroadcastDetailLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        {/* L8 — the settled page's Back link is `self-start`; so is this one, or
            its label would sit centred full-width and jump left on settle. */}
        <Link
          href="/portal/benefits?tab=broadcasts"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')}
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('back')}
        </Link>
        {/* F119 T086 — the stage banner (status badge + whose turn + expiry). */}
        <SkeletonBlock data-testid="detail-stage-banner-skeleton" className="h-16 w-full" />
        {/* Fields card: the header (the "Subject" overline over the subject
            heading), then the dl grid (recipients, submitted, sent, proposed
            and confirmed send time). */}
        <Card>
          <CardHeader className="space-y-1">
            <SkeletonBlock className="h-4 w-16" />
            <SkeletonBlock className="h-5.5 w-2/3" />
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <SkeletonBlock className="h-3 w-20" />
                  <SkeletonBlock className="h-5 w-28" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        {/* The content: the sign-off compare grid — the formatted version
            first, the member's original beside it at ≥ lg. Below lg only the
            first frame is reserved: the page may render one card (no version
            sent yet) or two stacked, and reserving one keeps the first
            viewport still either way. Frames are the page's own
            DETAIL_PREVIEW_FRAME_HEIGHT, so the reservation cannot drift. */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i} className={i === 1 ? 'hidden lg:flex' : undefined}>
              <CardHeader>
                <SkeletonBlock className="h-5 w-40" />
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <SkeletonBlock className="h-4 w-2/3" />
                <SkeletonBlock
                  data-testid={i === 0 ? 'detail-content-frame-skeleton' : 'detail-original-frame-skeleton'}
                  className="w-full"
                  style={{ height: DETAIL_PREVIEW_FRAME_HEIGHT }}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
