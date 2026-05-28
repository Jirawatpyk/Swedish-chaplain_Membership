/**
 * Shimmer skeleton for the staff <DirectoryTable> (F9 US5).
 *
 * Renders the EXACT shape of the real table — 7 fluid columns (company, tier,
 * industry, location, listed, logo, contact) as a CSS grid so the shell does NOT
 * shift when data lands (CLS 0, ux-standards § 2.1). Modelled on
 * `MembersTableSkeleton` so every admin list page shares one skeleton look; the
 * previous hand-rolled flex + fixed-px version misaligned with the real
 * `table-auto` columns and used a too-short row height.
 */
import { Skeleton } from '@/components/ui/skeleton';

const COLS = 7;
const GRID = 'repeat(7, minmax(0, 1fr))';

export function DirectoryTableSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div
        className="grid gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: GRID }}
      >
        {Array.from({ length: COLS }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 border-b px-4 py-3 last:border-b-0"
          style={{ gridTemplateColumns: GRID }}
        >
          {Array.from({ length: COLS }).map((__, c) => (
            <Skeleton key={c} className="h-5 w-full" />
          ))}
        </div>
      ))}
    </div>
  );
}
