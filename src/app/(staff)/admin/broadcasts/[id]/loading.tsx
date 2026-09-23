/**
 * F119 T142 / T063 (FR-047) — the skeleton must have the SHAPE of the real
 * page, or the arrival of the content is layout shift.
 *
 * `/admin/broadcasts/[id]` renders: a PageHeader with the stage badge; the
 * "Approval round" card (a five-field `<dl>`, three columns from `lg`); the
 * "Submission" card (a five-field `<dl>` in two columns); the message card —
 * a heading over the sandboxed frame at `DETAIL_PREVIEW_FRAME_HEIGHT`, the
 * same reservation the real `PreviewSurface` occupies; the audit timeline;
 * and the right-aligned action row of `h-9` buttons. On an E-Blast in design
 * the message card is replaced by the writing tool, which reserves its own
 * editor skeleton (`loadTiptapEditor`) and preview frame.
 *
 * `DetailContainer` matches `page.tsx` + `error.tsx` (`check:layout` pins the
 * page/loading pair). Only the framework-free `preview-frame-heights` module
 * is imported — never the client preview component.
 *
 * UX review M9: `aria-busy` like every other admin loading state; header bars
 * are capped (`w-full max-w-*`) so they fit 320 px; card-heading bars are
 * `h-5.5` — the real `<h2>` (`text-base leading-snug`) is ~22 px, not 20.
 */
import { DetailContainer } from '@/components/layout';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

function FieldSkeletons({ count }: { readonly count: number }): React.ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </>
  );
}

export default function AdminBroadcastDetailLoading(): React.ReactElement {
  return (
    <DetailContainer aria-busy="true">
      {/* PageHeader: subject (h1) + "member · subtitle" + the stage badge. */}
      <header className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-7 w-full max-w-72" />
          <Skeleton className="h-4 w-full max-w-80" />
        </div>
        <Skeleton className="h-5 w-24 rounded-4xl" />
      </header>

      {/* "Approval round" — whose turn, time in stage, round, proposed, scheduled. */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5.5 w-36" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FieldSkeletons count={5} />
          </div>
        </CardContent>
      </Card>

      {/* "Submission" — five `<dl>` rows in two columns. */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5.5 w-28" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldSkeletons count={5} />
          </div>
        </CardContent>
      </Card>

      {/* The message — heading + the sandboxed frame's fixed height. */}
      <Card>
        <CardHeader>
          <Skeleton className="h-5.5 w-24" />
        </CardHeader>
        <CardContent>
          <Skeleton className="w-full" style={{ height: DETAIL_PREVIEW_FRAME_HEIGHT }} />
        </CardContent>
      </Card>

      {/* Audit timeline. */}
      <Skeleton className="h-40 w-full" />

      {/* Right-aligned action row — real controls are `<Button>` h-9 (36 px). */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>
    </DetailContainer>
  );
}
