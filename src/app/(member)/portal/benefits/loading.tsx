/**
 * Route-level loading skeleton for `/portal/benefits` (ux-standards § 2.1).
 *
 * Mirrors the real page's top-to-bottom shape to keep CLS ≈ 0:
 *   PageHeader (title + subtitle)  →  [Benefits] [Broadcasts] tab strip  →  card.
 * The real page renders `<PageHeader>` then `<BenefitsTabs>` (TabsList variant
 * "line" + a `pt-4` TabsContent holding `<BenefitUsageCard>`), so we replicate
 * that order inside the same `<DetailContainer>` wrapper (its `flex flex-col
 * gap-[--page-section-gap]` owns the header → tabs spacing, matching the page).
 *
 * 058 G1: a route-level `loading.tsx` receives NO props, so it cannot read
 * `?tab=` — it always renders the default (benefits) card body. On a
 * `?tab=broadcasts` cold-load the user therefore sees the benefits-card
 * skeleton briefly, then the broadcasts panel swaps in (a minor, accepted shape
 * difference — not zero CLS). The default `?tab=benefits` load is shape-matched.
 * xhigh #11.
 *
 * R2-2: the tab strip now matches the F7 flag. The page passes
 * `showBroadcastsTab={env.features.f7Broadcasts}` to `<BenefitsTabs>`, which
 * renders the Broadcasts `TabsTrigger` only when true. `FEATURE_F7_BROADCASTS`
 * defaults FALSE, so an unconditional 2-pill skeleton would collapse to a
 * 1-tab strip on the swap (width CLS). A `loading.tsx` is a server component
 * and reads `env` synchronously, so we gate the SECOND (Broadcasts) pill on the
 * SAME flag; the first (Benefits) pill always renders.
 */
import { DetailContainer } from '@/components/layout';
import { env } from '@/lib/env';
import { Skeleton } from '@/components/ui/skeleton';
import { BenefitUsageSkeleton } from '@/components/benefits/benefit-usage-skeleton';

export default function Loading() {
  return (
    <DetailContainer aria-busy="true">
      {/* PageHeader-shaped block: h1 (text-h1 ≈ 30px) + subtitle (text-body,
          mt-1 = 0.25rem) — matches <PageHeader title subtitle /> at the top. */}
      <div className="flex flex-col">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-1 h-4 w-64" />
      </div>

      {/* Tab strip + active-panel card. The real TabsList variant="line" is a
          w-fit, transparent, gap-1 row of triggers with NO full-width bottom
          border — only the active tab gets a short 2px ::after underline. So
          the skeleton is two pills in a w-fit row (no border-b). The 8px gap
          (gap-2 on the real <Tabs>) + the TabsContent pt-4 (16px) reproduce the
          tabs → card spacing. */}
      <div className="flex flex-col gap-2">
        <div className="flex h-8 w-fit items-center gap-1">
          {/* Benefits pill — always rendered. */}
          <Skeleton className="h-7 w-20 rounded-sm" />
          {/* Broadcasts pill — only when F7 is on, matching the page's
              `showBroadcastsTab={env.features.f7Broadcasts}` gate (R2-2). */}
          {env.features.f7Broadcasts ? (
            <Skeleton className="h-7 w-24 rounded-sm" />
          ) : null}
        </div>
        <div className="pt-4">
          {/* Card only — the PageHeader above already supplies the page title,
              so suppress the shared skeleton's leading title/subtitle block. */}
          <BenefitUsageSkeleton withPageTitle={false} />
        </div>
      </div>
    </DetailContainer>
  );
}
