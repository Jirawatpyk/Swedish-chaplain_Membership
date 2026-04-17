/**
 * Shimmer skeleton for the members directory table.
 *
 * Renders the EXACT shape of the real table (same column count, same
 * row height, same grid) so the shell does NOT shift when the real
 * data lands — CLS 0 per ux-standards § 2.1.
 */

import { Skeleton } from '@/components/ui/skeleton';

export function MembersTableSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="grid grid-cols-8 gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div
          key={r}
          className="grid grid-cols-8 gap-3 border-b px-4 py-3 last:border-b-0"
        >
          {Array.from({ length: 8 }).map((__, c) => (
            <Skeleton key={c} className="h-5 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
