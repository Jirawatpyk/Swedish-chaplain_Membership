import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * T072 polish — `/portal/invoices/[invoiceId]` loading skeleton.
 *
 * Mirrors the detail page sections: meta grid (4 fields, no heading),
 * line-items card (title in CardHeader + 3 line rows), totals card
 * (title in CardHeader + trio). The line-items + totals cards carry a
 * title skeleton INSIDE a CardHeader so the shimmer→content swap
 * doesn't shift (D3 polish — real cards now render their `<h2>` in a
 * CardHeader). The header action skeleton is `h-11` (44px) to match the
 * page-header action buttons — member-portal tappable CTAs are ≥44px
 * (ux-standards § 9.1, WCAG 2.5.5 AAA on mobile).
 *
 * Real translated title/subtitle to match the settled page header —
 * same convention as the list-loading skeleton. Uses DetailContainer
 * (72rem) to match the page; mismatched containers would trigger
 * `pnpm check:layout` (FR-007 CLS-0).
 *
 * The void-banner skeleton is an accepted gap: `loading.tsx` cannot
 * read the invoice status, so a voided invoice's destructive banner
 * is not pre-shimmered.
 */
export default async function Loading() {
  const t = await getTranslations('portal.invoices.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <DetailContainer>
        <PageHeader
          title={t('title')}
          badge={<SkeletonBlock className="h-6 w-20" />}
          actions={<SkeletonBlock className="h-11 w-28" />}
        />
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
          <CardHeader>
            <SkeletonBlock className="h-5 w-32" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
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
          <CardHeader>
            <SkeletonBlock className="h-5 w-28" />
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-[1fr_auto]">
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
