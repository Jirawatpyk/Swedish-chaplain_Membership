/**
 * Shimmer skeleton matching the MemberForm shape for CLS 0 transitions.
 * Used by route-level loading.tsx on `/admin/members/new` and
 * `/admin/members/[memberId]/edit` so the fallback matches the real
 * page instead of flashing the directory-table skeleton inherited
 * from the parent segment's loading.tsx.
 */

import { Skeleton } from '@/components/ui/skeleton';

function FieldSkeleton({ full }: { readonly full?: boolean }) {
  return (
    <div className={full ? 'col-span-full' : ''}>
      <Skeleton className="mb-2 h-3 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

function SectionSkeleton({ fieldCount }: { readonly fieldCount: number }) {
  return (
    <div className="rounded-md border p-4">
      <Skeleton className="mb-4 h-4 w-32" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: fieldCount }).map((_, i) => (
          <FieldSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function MemberFormSkeleton() {
  return (
    <div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden>
      <Skeleton className="h-4 w-40" />
      <SectionSkeleton fieldCount={9} />
      <SectionSkeleton fieldCount={6} />
      <div className="flex items-center justify-end gap-2">
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-36" />
      </div>
    </div>
  );
}
