/**
 * Route-level loading skeleton for `/portal/benefits` (ux-standards § 2.1).
 * Updated for 058 G1: shows a two-tab shimmer + panel skeleton so a
 * ?tab=broadcasts deep-link doesn't flash the wrong shape (CLS = 0 per §10).
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';
import { BenefitUsageSkeleton } from '@/components/benefits/benefit-usage-skeleton';

export default function Loading() {
  return (
    <DetailContainer>
      <div className="flex gap-2 border-b pb-0 mb-4" aria-hidden>
        <Skeleton className="h-9 w-24 rounded-sm" />
        <Skeleton className="h-9 w-24 rounded-sm" />
      </div>
      <BenefitUsageSkeleton />
    </DetailContainer>
  );
}
