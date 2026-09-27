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
import { SkeletonBlock as Skeleton } from '@/components/shell/page-skeletons';
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

      {/* Tab strip + active-panel card, in AURA's tab shape (spec 122 US3):
          44px tabs 24px apart over a full-width 1px rule, then the panel 24px
          below. */}
      <div className="flex flex-col">
        <div className="flex h-[var(--aura-input-height)] items-center gap-6 border-b border-[var(--aura-border-default)]">
          {/* Benefits tab — always rendered. */}
          <Skeleton className="h-4 w-20" />
          {/* Broadcasts tab — only when F7 is on, matching the page's
              `showBroadcastsTab={env.features.f7Broadcasts}` gate (R2-2). */}
          {env.features.f7Broadcasts ? <Skeleton className="h-4 w-24" /> : null}
        </div>
        <div className="pt-6">
          {/* Card only — the PageHeader above already supplies the page title,
              so suppress the shared skeleton's leading title/subtitle block. */}
          <BenefitUsageSkeleton withPageTitle={false} />
        </div>
      </div>
    </DetailContainer>
  );
}
