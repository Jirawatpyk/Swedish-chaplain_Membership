/**
 * Shimmer skeleton for the read-only <AuditTable> (F9 US2).
 *
 * Mirrors the real 6-column audit table (time, event, actor, target, summary,
 * payload) as a CSS grid so the shell does NOT shift when data lands (CLS 0,
 * ux-standards § 2.1). Modelled on `MembersTableSkeleton` for a consistent admin
 * skeleton look; the time/event/summary/payload columns render two stacked lines
 * because the real cells are multi-line (dual UTC/local timestamp, code label +
 * value, wrapping summary, label/value payload pairs) — a single-line skeleton
 * was far shorter than the rendered row and caused a layout jump.
 */
import { Skeleton } from '@/components/ui/skeleton';

// Proportional widths: summary widest, time/payload wide, actor/target/event narrower.
const GRID = '1.2fr 1.4fr 1fr 1fr 2fr 1.6fr';

function TwoLine({ secondWidth }: { readonly secondWidth: string }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-full" />
      <Skeleton className={`h-3 ${secondWidth}`} />
    </div>
  );
}

export function AuditTableSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div
        className="grid gap-3 border-b bg-muted/40 px-4 py-3 text-xs font-medium text-muted-foreground"
        style={{ gridTemplateColumns: GRID }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
      {Array.from({ length: 8 }).map((_, r) => (
        <div
          key={r}
          className="grid gap-3 border-b px-4 py-3 last:border-b-0"
          style={{ gridTemplateColumns: GRID }}
        >
          <TwoLine secondWidth="w-4/5" />
          <TwoLine secondWidth="w-3/4" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <TwoLine secondWidth="w-3/5" />
          <TwoLine secondWidth="w-4/5" />
        </div>
      ))}
    </div>
  );
}
