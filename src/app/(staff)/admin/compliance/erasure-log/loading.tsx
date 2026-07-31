/**
 * Route-level loading UI for /admin/compliance/erasure-log — shimmer skeleton
 * in the final shape for CLS 0 (ux-standards § 2.1). Mirrors the Task 6 page
 * shape: PageHeader, then the filter-tabs + search toolbar row, then a list
 * of evidence-card skeletons, inside a TableContainer to match the page's
 * container (check:layout pairing).
 *
 * `EvidenceCard` (`_components/evidence-card.tsx`) is a native `<details>`
 * that renders COLLAPSED (summary-row height only) for complete erasures and
 * OPEN (full two-grid content) for half-run/overdue ones — urgency-first, so
 * most real cards land collapsed. `CollapsedCardSkeleton` mirrors the
 * `<summary>` row alone (`Card` with `p-0`, since `<details>` owns padding,
 * wrapping a `border-b px-6 py-4` row) so the shimmer→real transition has
 * zero layout shift for the common case; `ExpandedCardSkeleton` mirrors the
 * open two-section definition-grid content for the minority of cards that
 * render open.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/** Mirrors `EvidenceCard`'s collapsed `<summary>` row — no content below it. */
function CollapsedCardSkeleton(): React.JSX.Element {
  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-[1.375rem] w-40" />
          <Skeleton className="h-5 w-56" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-24 rounded-4xl" />
          <Skeleton className="size-4" />
        </div>
      </div>
    </Card>
  );
}

/** Mirrors `EvidenceCard`'s open state — summary row + the two sectioned definition grids. */
function ExpandedCardSkeleton(): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-6 w-24 rounded-4xl" />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Two sectioned definition grids. */}
        {[0, 1].map((s) => (
          <div key={s} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.compliance.erasureLog');
  return (
    <TableContainer aria-busy="true">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between" aria-hidden>
        <Skeleton className="h-8 w-72 rounded-lg" />
        <Skeleton className="h-9 w-64 rounded-md" />
      </div>

      <div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden>
        <CollapsedCardSkeleton />
        <ExpandedCardSkeleton />
        <CollapsedCardSkeleton />
      </div>
    </TableContainer>
  );
}
