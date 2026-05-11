/**
 * F8 admin cycle-detail page loading skeleton — K27 / B-3 + I-4 fixes.
 *
 * - **B-3**: skeleton card count matches real page (4 cards) so
 *   skeleton → content transition is CLS-0.
 * - **I-4**: skeleton wraps in plain `<div>` (NOT `<header>` /
 *   `<section>`) so screen readers don't announce phantom landmarks
 *   during the load. The real `PageHeader` renders the `<header>`
 *   landmark; the skeleton must not duplicate it.
 *
 * Shimmer convention follows `docs/ux-standards.md § 2.1`. The
 * `role="status"` + `aria-live="polite"` pair lets AT users hear the
 * loading announcement without disrupting current focus.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

const FALLBACK_LOADING_ANNOUNCE = 'Loading cycle detail…';

async function resolveLoadingAnnounce(): Promise<string> {
  try {
    const t = await getTranslations('admin.renewals.cycleDetail');
    return t('loading');
  } catch (e) {
    console.warn(
      '[admin/renewals/[cycleId]/loading] getTranslations failed — falling back to EN canonical',
      { err: e instanceof Error ? e.message : String(e) },
    );
    return FALLBACK_LOADING_ANNOUNCE;
  }
}

/**
 * K27 Round 2 N-3: bespoke skeleton matching the real Activity card's
 * EmptyState height (icon + title + description inside a dashed
 * border). The previous `SkeletonCard rows={2}` was ~40px; this is
 * ~160px to match `EmptyState` at full size. CLS-0 holds.
 */
function SkeletonEmptyStateCard() {
  return (
    <div className="rounded-lg border bg-card">
      <div className="space-y-3 px-6 py-6">
        <Skeleton className="h-6 w-32" />
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-12">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
    </div>
  );
}

function SkeletonCard({
  rows,
  hasSeparator = false,
}: {
  readonly rows: number;
  readonly hasSeparator?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <div className="space-y-4 py-6">
        <div className="px-6">
          <Skeleton className="h-6 w-40" />
        </div>
        <div className="space-y-2 px-6">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-x-4"
            >
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
        {hasSeparator && (
          <>
            <div className="px-6">
              <Skeleton className="h-px w-full" />
            </div>
            <div className="space-y-2 px-6">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="grid grid-cols-1 gap-y-1 text-sm sm:grid-cols-[10rem_1fr] sm:gap-x-4"
                >
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-48" />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default async function AdminCycleDetailLoading() {
  const announce = await resolveLoadingAnnounce();
  return (
    <DetailContainer>
      <div role="status" aria-live="polite">
        <span className="sr-only">{announce}</span>
        {/* PageHeader skeleton — real PageHeader is the <header> landmark;
            this is just visual scaffolding to avoid CLS. */}
        <div className="mb-6">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="mt-2 h-4 w-80" />
        </div>
        {/* 4 cards mirror real page (S-1: Member+Plan merged, Invoice,
            Period, Activity). Member+Plan card uses 4-row top + 4-row
            bottom around a separator. K27 Round 2 N-3: Activity card
            uses bespoke EmptyState-shaped skeleton so the
            skeleton→content height delta is ≤10px (the rows=2 default
            was ~40px vs real EmptyState ~160px → measurable CLS). */}
        <div className="space-y-6">
          {/* I-5 (UX R3): Period card now renders 3 always-visible
              date rows (periodFrom/periodTo/expiresAt) plus a
              collapsed <details> block for createdAt/updatedAt. The
              skeleton matches the always-visible row count for the
              common-path `upcoming`/`reminded` cycle (CLS-0). lapsed
              and pending cycles will shift content down by one row;
              acceptable trade because that's the rarer path. */}
          <SkeletonCard rows={4} hasSeparator />
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
          <SkeletonEmptyStateCard />
        </div>
      </div>
    </DetailContainer>
  );
}
