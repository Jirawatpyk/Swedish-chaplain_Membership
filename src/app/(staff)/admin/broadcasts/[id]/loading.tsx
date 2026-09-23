/**
 * F119 T142 (FR-047) — the skeleton must have the SHAPE of the real page.
 *
 * The previous version reserved four equal 80 px tiles in a 2-column grid and
 * two loose blocks, which is not what `/admin/broadcasts/[id]` renders: a
 * PageHeader with a status badge, a bordered facts panel holding a SIX-row
 * `<dl>` in two columns, a bordered body panel with its own overline heading,
 * the audit timeline, and a right-aligned action row. Every mismatch is layout
 * shift at the moment the content arrives, which is exactly what the loading
 * state exists to prevent.
 *
 * `DetailContainer` matches `page.tsx` + `error.tsx` (`check:layout` pins the
 * page/loading pair).
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminBroadcastDetailLoading(): React.ReactElement {
  return (
    <DetailContainer>
      {/* PageHeader: subject (h1) + "member · subtitle" + the status badge. */}
      <header className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-5 w-24 rounded-4xl" />
      </header>

      {/* Facts panel — six `<dl>` rows in two columns, same border + padding. */}
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-40" />
            </div>
          ))}
        </div>
      </div>

      {/* Body panel — overline heading + the rendered message. */}
      <div className="rounded-md border bg-background p-4">
        <Skeleton className="mb-2 h-3 w-20" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>

      {/* Audit timeline. */}
      <Skeleton className="h-40 w-full" />

      {/* Right-aligned action row — real controls are `<Button>` h-9 (36 px). */}
      <div className="flex items-center justify-end gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>
    </DetailContainer>
  );
}
