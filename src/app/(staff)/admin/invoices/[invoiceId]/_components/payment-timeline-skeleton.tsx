/**
 * Suspense fallback for `<PaymentTimeline>`. Heights mirror the real
 * card at typical paid-online density (h-6 title + h-12 chip block +
 * 3×h-14 events). `skeleton-shimmer` drops to `animate-pulse` under
 * `prefers-reduced-motion: reduce` (see globals.css).
 *
 * CR-7 (review 2026-04-27): aria-label routed through next-intl
 * server-side translations so TH/SV admins hear the loading state in
 * their locale instead of hardcoded EN.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export async function PaymentTimelineSkeleton() {
  const t = await getTranslations('admin.paymentReconciliation.timeline');
  return (
    <Card aria-busy="true" aria-label={t('loading')}>
      <CardContent className="flex flex-col gap-3 py-6">
        {/* R2 F-6: <Skeleton> primitive already applies skeleton-shimmer
            internally — passing it here duplicates the class on the
            DOM and diverges from every other skeleton in the codebase. */}
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </CardContent>
    </Card>
  );
}
