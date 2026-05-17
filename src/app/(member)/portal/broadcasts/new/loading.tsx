/**
 * T080 — Compose page loading skeleton.
 *
 * Shimmer skeleton matches the real form footprint to minimise CLS:
 *   - PageHeader (title + subtitle)
 *   - Subject input
 *   - Segment radio group (4 rows)
 *   - Editor area (≈ 280 px)
 *   - Schedule picker
 *   - Preview pane
 *   - Submit button row
 */
import { FormContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function ComposeLoading(): React.ReactElement {
  return (
    <FormContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </header>
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-6 w-48" />
          </div>
        </div>
        <Skeleton className="h-[280px] w-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-32 w-full" />
        <div className="flex justify-end gap-2">
          {/* E1 UX hardening — match the real `<Button>` h-9 (36 px)
              per shadcn-customizations.md instead of h-10 → eliminates
              the 4 px CLS when the form mounts. */}
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </FormContainer>
  );
}
