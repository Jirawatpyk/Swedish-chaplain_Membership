/**
 * F9 US4 — shimmer skeleton for the benefit-usage pages (ux-standards § 2.1,
 * CLS = 0). Shared by the member + staff `loading.tsx` so both route-level
 * suspense fallbacks match the rendered card's shape.
 *
 * `withPageTitle` (default true) renders a leading title+subtitle shimmer block
 * that approximates the standalone staff benefits page's heading. The member
 * tabbed `/portal/benefits/loading.tsx` already renders its own PageHeader-shaped
 * skeleton ABOVE the tab strip, so it passes `withPageTitle={false}` to get the
 * card-only body and avoid a duplicated/misplaced title block below the tabs.
 */
import { SkeletonBlock as Skeleton } from '@/components/shell/page-skeletons';

export function BenefitUsageSkeleton({
  withPageTitle = true,
}: {
  readonly withPageTitle?: boolean;
} = {}): React.ReactElement {
  // AURA card shape (spec 122 US3), mirroring the real card's head
  // (<h2> title + the liveNote caption) and body so the swap has no CLS.
  const card = (
    <div className="aura-card">
      <div className="aura-card__head flex-col items-start gap-1">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3 w-56" />
      </div>
      <div className="aura-card__body flex flex-col gap-5">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-40" />
          </div>
        ))}
      </div>
    </div>
  );

  if (!withPageTitle) return card;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      {card}
    </div>
  );
}
