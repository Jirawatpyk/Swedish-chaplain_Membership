/**
 * Suspense fallback for `<PaymentTimeline>`. Heights mirror the real
 * card at typical paid-online density (h-6 title + h-12 chip block +
 * 3×h-14 events), on the AURA card and skeleton blocks the timeline
 * uses (spec 122 US8b).
 *
 * CR-7 (review 2026-04-27): aria-label routed through next-intl
 * server-side translations so TH/SV admins hear the loading state in
 * their locale instead of hardcoded EN.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

export async function PaymentTimelineSkeleton() {
  const t = await getTranslations('admin.paymentReconciliation.timeline');
  return (
    // `role="status"`: aria-label is not permitted on a role-less element
    // (axe aria-prohibited-attr), and status is what this region is.
    <Card role="status" aria-busy="true" aria-label={t('loading')}>
      <div className="flex flex-col gap-3">
        <SkeletonBlock className="h-6 w-40" />
        <SkeletonBlock className="h-12 w-full" />
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
      </div>
    </Card>
  );
}
