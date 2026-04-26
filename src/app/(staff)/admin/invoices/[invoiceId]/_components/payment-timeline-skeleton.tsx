/**
 * F5 Phase 5 R3-fix S4 (2026-04-26) — Suspense fallback skeleton for
 * `<PaymentTimeline>`.
 *
 * Shape mirrors the real timeline at typical paid-online density to
 * minimise CLS:
 *   - h-6  → CardTitle "Payment activity"
 *   - h-12 → processor charge id chip block
 *   - h-14 ×3 → event rows (payment_initiated → payment_succeeded
 *                → invoice_paid; the typical 3-event chain)
 *
 * `skeleton-shimmer` class drops to `animate-pulse` under
 * `prefers-reduced-motion: reduce` (see globals.css § shimmer block).
 */
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function PaymentTimelineSkeleton() {
  return (
    <Card>
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
