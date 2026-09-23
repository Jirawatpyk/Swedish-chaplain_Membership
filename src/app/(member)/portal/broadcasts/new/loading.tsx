/**
 * F119 T142 (FR-047) — the compose skeleton must have the SHAPE of the real
 * compose page.
 *
 * The previous version was authored against the T080 form and never followed
 * it: it omitted the `QuotaDisplay` card, the template combobox, the `Card`
 * wrapper around the fields and the subject counter, and — since `8a458e6a9`
 * (T148, FR-050) — it was a single 42 rem column while the page is a two-column
 * `DetailContainer` grid with the 600 px email preview beside the editor from
 * `lg` up. Each of those is a jump at the moment the form mounts.
 *
 * Mirrors `compose-form.tsx`'s tree, top to bottom:
 *   QuotaDisplay card → template combobox → grid[editor Card | preview column]
 * with the editor Card holding subject (+ counter), recipients, the message
 * editor, the schedule picker, the cancellation note and the action row.
 *
 * `DetailContainer` matches `page.tsx` + `error.tsx` (`check:layout` pins the
 * page/loading pair).
 */
import { DetailContainer } from '@/components/layout';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function ComposeLoading(): React.ReactElement {
  return (
    <DetailContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </header>

      <div className="min-w-0 space-y-6">
        {/* QuotaDisplay — the allowance card above the form. */}
        <Card>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-56" />
          </CardContent>
        </Card>

        {/* Template picker — label, combobox trigger (h-9), help line. */}
        <div className="space-y-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-9 w-full sm:w-80" />
          <Skeleton className="h-3 w-72" />
        </div>

        {/* T148 — editor beside the 600 px preview from `lg` up, stacked below. */}
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)]">
          <Card>
            <CardContent className="space-y-6">
              {/* Subject + its character counter. */}
              <div className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-3 w-28" />
              </div>

              {/* Recipients — four radio rows. */}
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <div className="space-y-2">
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-6 w-48" />
                  <Skeleton className="h-6 w-48" />
                </div>
                <Skeleton className="h-3 w-64" />
              </div>

              {/* Message — label + the editor's toolbar and canvas. */}
              <div className="space-y-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-[280px] w-full" />
              </div>

              {/* Schedule picker. */}
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-9 w-full" />
              </div>

              {/* The "you can still cancel" note. */}
              <Skeleton className="h-3 w-80" />

              <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
                {/* E1 UX hardening — match the real `<Button>` h-9 (36 px)
                    per shadcn-customizations.md instead of h-10 → eliminates
                    the 4 px CLS when the form mounts. */}
                <Skeleton className="h-9 w-28" />
                <Skeleton className="h-9 w-32" />
              </div>
            </CardContent>
          </Card>

          {/* Preview column — label + the 420 px frame `PreviewPane` reserves. */}
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-[420px] w-full" />
          </div>
        </div>
      </div>
    </DetailContainer>
  );
}
