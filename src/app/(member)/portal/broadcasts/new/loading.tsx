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
 * The form's shape is `ComposeFormSkeleton` (shared with the staff compose
 * skeleton since U12, #400 PR-B, which also made the quota card a four-counter
 * grid and the editor toolbar a wrap of 44 px controls — both used to be
 * under-reserved).
 *
 * `DetailContainer` matches `page.tsx` + `error.tsx` (`check:layout` pins the
 * page/loading pair).
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';
import { ComposeFormSkeleton } from '@/components/broadcast/compose-form-skeleton';
import { env } from '@/lib/env';

export default function ComposeLoading(): React.ReactElement {
  return (
    <DetailContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </header>
      <ComposeFormSkeleton variant="member" imageControls={env.features.f71aUs2Images} />
    </DetailContainer>
  );
}
