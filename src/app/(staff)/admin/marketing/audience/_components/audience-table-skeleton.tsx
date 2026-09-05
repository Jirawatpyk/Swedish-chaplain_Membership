/**
 * 108 PR-D (FR-035b) — shimmer skeleton in the audience table's final shape
 * (ux-standards § 2.1, CLS 0). Column count matches `AudienceTable` for the
 * viewer's role: the switch column exists only for `contacts.marketing`
 * holders.
 */
import { Skeleton } from '@/components/ui/skeleton';

export function AudienceTableSkeleton({
  withSwitch = false,
}: {
  readonly withSwitch?: boolean;
} = {}) {
  const cols = withSwitch ? 8 : 7;
  const rows = 15;
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-4 w-56" />
      <div className="overflow-x-auto">
        <div
          className="grid min-w-[960px] gap-x-4 gap-y-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={`h-${i}`} className="h-3 w-20" />
          ))}
          {Array.from({ length: rows * cols }, (_, i) => (
            <Skeleton key={`c-${i}`} className="h-5" />
          ))}
        </div>
      </div>
      <Skeleton className="h-9 w-72 self-end" />
    </div>
  );
}
