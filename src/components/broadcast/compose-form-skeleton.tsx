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
 *   - the quota card (since spec 122 US12d-3 the one-line `variant="line"`:
 *     the sentence with the bar beside it, under it on a phone);
 *   - the editor toolbar is a WRAP of 44 px controls (`tiptap-toolbar.tsx`:
 *     h-11 each, `gap-0.5 p-1`), one or two rows depending on the column width —
 *     not one h-9 bar. It reserves the count the toolbar renders: thirteen, plus
 *     the image and banner controls while `FEATURE_F71A_US2_IMAGES` is on
 *     (#400 U4 — the caller's server `loading.tsx` reads the flag); the wrap
 *     then decides the height the same way it does for the real toolbar. On a
 *     phone only the boards' eight show (`max-sm:hidden` on the rest).
 *
 * Help lines wider than a phone column are `w-full max-w-*` (#400 U3): at
 * 320 px the card leaves ~240 px, so a bare `w-64`+ bar overflowed it.
 *
 * Spec 122 US12d-3 (T1270) — AURA's server Card and the shared
 * `SkeletonBlock`. The fields, radio rows and buttons are AURA's 44 px on a
 * phone now (`touchHeight`; Buttons are 44 px everywhere), so their bars are
 * too, and the help lines sit under their fields as AURA draws them.
 */
import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock as Skeleton } from '@/components/shell/page-skeletons';

/** `tiptap-toolbar.tsx`: thirteen controls (Undo and Redo included), + image + banner with the image flag on. */
const TOOLBAR_CONTROLS = 13;
const IMAGE_CONTROLS = 2;
/** On a phone the toolbar is the boards' row: B, I, U, Link, two menus, Undo, Redo (spec 122, 26 Oct 2026). */
const PHONE_CONTROLS = 8;

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
        // QuotaDisplay `variant="line"` — one line with the bar beside it
        // (spec 122 US12d-3), the bar under it on a phone.
        <Card>
          <div data-skeleton="quota-line" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Skeleton className="h-5 w-full sm:w-64" />
            <Skeleton className="h-2 w-full rounded-full sm:w-72" />
          </div>
        </Card>
      ) : null}

      {/* Template picker — label, the combobox, help line. */}
      <div className="space-y-2 sm:max-w-md">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-11 w-full sm:h-9" />
        <Skeleton className="h-3 w-full max-w-72" />
      </div>

      {/* T148 — editor beside the 600 px preview from `lg` up, stacked below. */}
      <div
        data-skeleton="compose-grid"
        className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]"
      >
        <Card>
          <div className="space-y-6">
            {variant === 'staff' ? (
              <>
                {/* MemberPicker — label + the combobox. */}
                <div data-skeleton="member-picker" className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-11 w-full sm:h-9" />
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
              <div className="overflow-hidden rounded-md border border-[var(--aura-border-default)]">
                <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--aura-border-default)] p-1">
                  {Array.from({ length: toolbarControls }).map((_, i) => (
                    <Skeleton
                      key={i}
                      data-skeleton="toolbar-control"
                      className={i < PHONE_CONTROLS ? 'h-11 w-11' : 'h-11 w-11 max-sm:hidden'}
                    />
                  ))}
                </div>
                <Skeleton className="h-[280px] w-full rounded-none" />
              </div>
            </div>

            {/* Send options — the one disclosure line ("Send options ·
                Sending now"), 44 px on a phone; its field opens on demand. */}
            <Skeleton className="h-11 w-full max-w-72 sm:h-9" />

            {/* The "you can still cancel" note. */}
            <Skeleton className="h-3 w-full max-w-80" />

            <div className="flex flex-col-reverse gap-2 border-t border-[var(--aura-border-subtle)] pt-4 sm:flex-row sm:items-center sm:justify-end">
              {/* AURA's Buttons are 44 px (`md`), Save as draft and Submit. */}
              <Skeleton className="h-11 w-full sm:w-28" />
              <Skeleton className="h-11 w-full sm:w-32" />
            </div>
          </div>
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
      <Skeleton className="h-11 w-full sm:h-9" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

/** Recipients — the segment picker's four radio rows (44 px on a phone) and the count line. */
function RecipientsSkeleton(): React.ReactElement {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full max-w-48 sm:h-6" />
        ))}
      </div>
      <Skeleton className="h-3 w-full max-w-64" />
    </div>
  );
}
