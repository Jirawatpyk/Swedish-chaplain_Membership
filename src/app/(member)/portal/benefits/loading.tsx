/**
 * Route-level loading skeleton for `/portal/benefits` (ux-standards § 2.1).
 *
 * 058 G1: a route-level `loading.tsx` receives NO props, so it cannot read
 * `?tab=` — it renders a NEUTRAL two-tab chrome + a single benefits-shaped
 * panel skeleton. On a `?tab=broadcasts` cold-load the user therefore sees
 * this neutral panel skeleton briefly, then the broadcasts panel swaps in
 * (a minor, accepted shape difference — not zero CLS). The default
 * `?tab=benefits` load is shape-matched. xhigh #11.
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
