/**
 * F119 U12 (#400 PR-B) — the compose form's loading shape, SHARED by the member
 * (`/portal/broadcasts/new/loading.tsx`) and the staff
 * (`/admin/broadcasts/new/loading.tsx`) skeletons, so the two cannot drift
 * from each other again; `compose-and-settings-skeletons.test.tsx` pins both.
 *
 * Mirrors `compose-form.tsx` / `proxy-compose-form.tsx` top to bottom:
 *   [member: the QuotaDisplay card] → template picker →
 *   grid[editor Card | the 600 px preview column] (T148 — side by side from
 *   `lg` up, stacked below)
 * with the editor Card holding (member) subject (+ counter) → recipients, or
 * (staff) the member picker → recipients → subject — each form's own order —
 * then the message editor → the schedule picker → the
 * cancellation note → the action row.
 *
 * Two regions used to be under-reserved (U12):
 *   - the quota card is a 2×2 / 1×4 grid of counters (`text-2xl` value over a
 *     `text-xs` label) plus the progress bar — not one line;
 *   - the editor toolbar is a WRAP of 44 px controls (`tiptap-toolbar.tsx`:
 *     h-11 each, `gap-1 p-1`), one or two rows depending on the column width —
 *     not one h-9 bar. It reserves the count the toolbar renders: eleven, plus
 *     the image and banner controls while `FEATURE_F71A_US2_IMAGES` is on
 *     (#400 U4 — the caller's server `loading.tsx` reads the flag); the wrap
 *     then decides the height the same way it does for the real toolbar.
 *
 * Help lines wider than a phone column are `w-full max-w-*` (#400 U3): at
 * 320 px the card leaves ~240 px, so a bare `w-64`+ bar overflowed it.
 */
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** `tiptap-toolbar.tsx`: eleven controls, + image + banner with the image flag on. */
const TOOLBAR_CONTROLS = 11;
const IMAGE_CONTROLS = 2;

export interface ComposeFormSkeletonProps {
  /** `member` shows the quota card above the form; `staff` starts the editor card with the member picker (no allowance until a member is picked). */
  readonly variant: 'member' | 'staff';
  /** `env.features.f71aUs2Images` — the toolbar's image + banner controls render only with it on. */
  readonly imageControls: boolean;
}

export function ComposeFormSkeleton({ variant, imageControls }: ComposeFormSkeletonProps): React.ReactElement {
  const toolbarControls = TOOLBAR_CONTROLS + (imageControls ? IMAGE_CONTROLS : 0);
  return (
    <div className="min-w-0 space-y-6">
      {variant === 'member' ? (
        // QuotaDisplay — the allowance card above the form.
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} data-skeleton="quota-counter" className="flex flex-col items-center">
                  <Skeleton className="h-8 w-10" />
                  <Skeleton className="h-4 w-14" />
                </div>
              ))}
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </CardContent>
        </Card>
      ) : null}

      {/* Template picker — label, combobox trigger (h-9), help line. */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-9 w-full sm:w-80" />
        <Skeleton className="h-3 w-full max-w-72" />
      </div>

      {/* T148 — editor beside the 600 px preview from `lg` up, stacked below. */}
      <div
        data-skeleton="compose-grid"
        className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]"
      >
        <Card>
          <CardContent className="space-y-6">
            {variant === 'staff' ? (
              <>
                {/* MemberPicker — label + the combobox trigger. */}
                <div data-skeleton="member-picker" className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-9 w-full" />
                </div>
                <RecipientsSkeleton />
                <SubjectSkeleton />
              </>
            ) : (
              <>
                <SubjectSkeleton />
                <RecipientsSkeleton />
              </>
            )}

            {/* Message — label, then the editor frame: the toolbar's wrap of
                44 px controls over the canvas. */}
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <div className="overflow-hidden rounded-md border">
                <div className="flex flex-wrap items-center gap-1 border-b p-1">
                  {Array.from({ length: toolbarControls }).map((_, i) => (
                    <Skeleton key={i} data-skeleton="toolbar-control" className="h-11 w-11" />
                  ))}
                </div>
                <Skeleton className="h-[280px] w-full rounded-none" />
              </div>
            </div>

            {/* Schedule picker. */}
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>

            {/* The "you can still cancel" note. */}
            <Skeleton className="h-3 w-full max-w-80" />

            <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
              {/* The real `<Button>`s are h-9 (36 px). */}
              <Skeleton className="h-9 w-28" />
              <Skeleton className="h-9 w-32" />
            </div>
          </CardContent>
        </Card>

        {/* Preview column — label + the 420 px frame `PreviewPane` reserves. */}
        <div data-skeleton="preview-pane" className="min-w-0 space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      </div>
    </div>
  );
}

/** Subject + its character counter. */
function SubjectSkeleton(): React.ReactElement {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

/** Recipients — the segment picker's four radio rows and its help line. */
function RecipientsSkeleton(): React.ReactElement {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-6 w-48" />
      </div>
      <Skeleton className="h-3 w-full max-w-64" />
    </div>
  );
}
