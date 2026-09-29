/**
 * Skeleton of the member detail page body for CLS 0 transitions (spec 122
 * US5b-1: the `Admin-member-detail` board's shape). Used by
 * `/admin/members/[memberId]/loading.tsx`, which owns the header. Mirrors the
 * page: figures strip → section links → Company + Contacts beside Renewal &
 * Health and Benefits → Invoices → Timeline beside Data export.
 *
 * Decorative (`aria-hidden`); the route's `PageSkeletonShell` is the one live
 * region that says "Loading".
 */
import { SkeletonBlock } from '@/components/shell/page-skeletons';

const CARD =
  'flex flex-col gap-4 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-5 max-sm:p-4';

function DlRowSkeleton() {
  return (
    <div className="flex flex-col gap-1 py-2">
      <SkeletonBlock className="h-3 w-20" />
      <SkeletonBlock className="h-4 w-32" />
    </div>
  );
}

function CardSkeleton({ rows, grid = false }: { readonly rows: number; readonly grid?: boolean }) {
  return (
    <div className={CARD}>
      <SkeletonBlock className="h-5 w-32" />
      <div className={grid ? 'grid grid-cols-1 gap-x-8 md:grid-cols-2 xl:grid-cols-3' : 'flex flex-col gap-2'}>
        {Array.from({ length: rows }).map((_, i) => (
          <DlRowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function MemberDetailSkeleton() {
  // Fragment: the enclosing DetailContainer supplies the section gap.
  return (
    <>
      <div
        aria-hidden
        className="grid grid-cols-2 rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] sm:grid-cols-4"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1.5 px-5 py-3.5">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-3 w-24" />
          </div>
        ))}
      </div>
      <div aria-hidden className="flex h-11 items-center gap-6 border-b border-[var(--aura-border-default)]">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-4 w-20" />
        ))}
      </div>
      <div aria-hidden className="grid grid-cols-1 items-start gap-[var(--page-section-gap)] lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-[var(--page-section-gap)]">
          <CardSkeleton rows={9} grid />
          <CardSkeleton rows={4} grid />
        </div>
        <div className="flex flex-col gap-[var(--page-section-gap)]">
          <CardSkeleton rows={3} />
          <CardSkeleton rows={2} />
        </div>
      </div>
      <div aria-hidden className={CARD}>
        <SkeletonBlock className="h-5 w-28" />
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-10 w-full" />
        ))}
      </div>
    </>
  );
}
