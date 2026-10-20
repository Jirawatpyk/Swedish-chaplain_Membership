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
 * are capped (`w-full max-w-*`) so they fit 320 px. Spec 122 US12c-1: the
 * cards are AURA cards (a skeleton bar in the card head where the h2 sits,
 * `h-6` — AURA's card title is 16 px at a 1.5 line height) and the bars are
 * the shared `SkeletonBlock`.
 *
 * T086a V7 — the content slot. The skeleton cannot know the stage, so it
 * reserves the most common shape: the TWO-COLUMN grid from `lg`. Once a
 * version exists — `in_design`, and every stage after a version was sent —
 * the page renders its content that way: the writing tool (`in_design`, for
 * a writer) or the read-only version, with the member's original beside it.
 * Only `submitted` (and an E-Blast that never entered the round) renders the
 * one-card round-0 shape. As the member's sign-off skeleton does, the first
 * card is reserved at every width (below `lg` every shape starts with one
 * card over a preview frame) and the second from `lg` only. Chosen over the
 * writing tool's `[1fr_600px]` template because the read-only comparison is
 * the shape every reader sees, a manager included; the writer's first column
 * is taller than a frame, and that difference lands below the fold.
 */
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';

function FieldSkeletons({ count }: { readonly count: number }): React.ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-1">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-5 w-40 max-w-full" />
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
          <SkeletonBlock className="h-8 w-full max-w-72" />
          <SkeletonBlock className="h-4 w-full max-w-80" />
        </div>
        <SkeletonBlock className="h-6 w-28 rounded-full" />
      </header>

      {/* "Approval round" — whose turn, time in stage, round, proposed, scheduled. */}
      <Card header={<SkeletonBlock className="h-6 w-36" />}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <FieldSkeletons count={5} />
        </div>
      </Card>

      {/* "Submission" — five `<dl>` rows in two columns. */}
      <Card header={<SkeletonBlock className="h-6 w-28" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldSkeletons count={5} />
        </div>
      </Card>

      {/* The content (V7 above): the version, the member's original beside it
          from lg — a heading, the subject line, the sandboxed frame. */}
      <div data-skeleton="content-grid" className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <Card
            key={i}
            header={<SkeletonBlock className="h-6 w-40 max-w-full" />}
            className={i === 1 ? 'hidden lg:flex' : undefined}
          >
            <div className="space-y-2">
              <SkeletonBlock className="h-5 w-2/3" />
              <SkeletonBlock
                data-skeleton="preview-frame"
                className="w-full"
                style={{ height: DETAIL_PREVIEW_FRAME_HEIGHT }}
              />
            </div>
          </Card>
        ))}
      </div>

      {/* "Lifecycle timeline" — an AURA card, one row per step. */}
      <Card header={<SkeletonBlock className="h-6 w-40" />}>
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex items-start gap-[var(--aura-space-3)]">
              <SkeletonBlock className="size-4 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1">
                <SkeletonBlock className="h-5 w-24" />
                <SkeletonBlock className="h-4 w-full max-w-72" />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* The action row — the destructive actions at the start, the next step
          at the end (AURA buttons, h-9; 44 px on touch). Below 640px Cancel and
          Start sit in a ⋯ menu: Reject · Approve · ⋯. */}
      <div data-skeleton="action-row" className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <SkeletonBlock className="h-9 w-28 max-sm:hidden" />
          <SkeletonBlock className="h-9 w-24 max-sm:h-11" />
        </div>
        <div className="flex gap-2">
          <SkeletonBlock className="h-9 w-40 max-sm:hidden" />
          <SkeletonBlock className="h-9 w-24 max-sm:h-11" />
          <SkeletonBlock className="hidden size-11 max-sm:block" />
        </div>
      </div>
    </DetailContainer>
  );
}
