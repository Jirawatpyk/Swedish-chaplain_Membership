/**
 * Suspense fallback for `<PaymentTimeline>`. Heights mirror the real
 * card at typical paid-online density (h-6 title + h-12 chip block +
 * 3×h-14 events). `skeleton-shimmer` drops to `animate-pulse` under
 * `prefers-reduced-motion: reduce` (see globals.css).
 */
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function PaymentTimelineSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading payment activity">
      <CardContent className="flex flex-col gap-3 py-6">
        <Skeleton className="h-6 w-40 skeleton-shimmer" />
        <Skeleton className="h-12 w-full skeleton-shimmer" />
        <Skeleton className="h-14 w-full skeleton-shimmer" />
        <Skeleton className="h-14 w-full skeleton-shimmer" />
        <Skeleton className="h-14 w-full skeleton-shimmer" />
      </CardContent>
    </Card>
  );
}
