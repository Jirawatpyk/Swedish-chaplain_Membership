/**
 * Skeleton matching the MemberForm shape for CLS 0 transitions. Used by
 * route-level loading.tsx on `/admin/members/new` and
 * `/admin/members/[memberId]/edit` so the fallback matches the real page
 * instead of flashing the directory-table skeleton inherited from the parent
 * segment's loading.tsx.
 *
 * Spec 122 US5b-2: the boards' one card per fieldset (two fields a row from
 * 640px), the required-fields note and the right-aligned buttons. Decorative
 * (`aria-hidden`); the page's `PageSkeletonShell` announces the load.
 */
import { SkeletonBlock } from '@/components/shell/page-skeletons';

const CARD =
  'flex flex-col gap-4 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-6 max-sm:p-4';

function FieldSkeleton({ full }: { readonly full?: boolean }) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <SkeletonBlock className="mb-2 h-3 w-24" />
      <SkeletonBlock className="h-11 w-full" />
    </div>
  );
}

function SectionSkeleton({ fieldCount }: { readonly fieldCount: number }) {
  return (
    <div className={CARD}>
      <SkeletonBlock className="h-5 w-32" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FieldSkeleton full />
        {Array.from({ length: fieldCount - 1 }).map((_, i) => (
          <FieldSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function MemberFormSkeleton({
  withLocaleCard = false,
}: {
  /** The edit page's notification-language card, above the form. */
  readonly withLocaleCard?: boolean;
} = {}) {
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden="true">
      {withLocaleCard && (
        <div className={CARD}>
          <SkeletonBlock className="h-3 w-36" />
          <SkeletonBlock className="h-6 w-full max-w-md" />
          <SkeletonBlock className="h-11 w-36" />
        </div>
      )}
      <SkeletonBlock className="h-4 w-40" />
      <SectionSkeleton fieldCount={5} />
      <SectionSkeleton fieldCount={4} />
      <div className="flex items-center justify-end gap-2 max-sm:hidden">
        <SkeletonBlock className="h-11 w-24" />
        <SkeletonBlock className="h-11 w-36" />
      </div>
    </div>
  );
}
