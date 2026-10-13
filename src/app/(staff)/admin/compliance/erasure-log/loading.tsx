/**
 * Route-level loading UI for /admin/compliance/erasure-log, in the final
 * shape for CLS 0: PageHeader, then the status tabs + member-number search
 * row, then a list of evidence-card skeletons, inside a TableContainer to
 * match the page's container (check:layout pairing).
 *
 * `EvidenceCard` is a native `<details>` that renders COLLAPSED (summary-row
 * height only) for complete erasures and OPEN for half-run/overdue ones —
 * urgency-first, so most real cards land collapsed. `CollapsedCardSkeleton`
 * mirrors the `<summary>` row alone; `ExpandedCardSkeleton` adds the open
 * definition grids for the minority of cards that render open.
 *
 * Spec 122 US10b (T1017): on AURA — the page skeleton shell, AURA cards and
 * the AURA pulse skeleton, the search with its visible label as the page now
 * draws it.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

const ROW = 'flex items-start justify-between gap-[var(--aura-space-3)] px-[var(--aura-space-5)] py-[var(--aura-space-4)]';

/** Mirrors `EvidenceCard`'s collapsed `<summary>` row — no content below it. */
function CollapsedCardSkeleton(): React.JSX.Element {
  return (
    <Card className="overflow-hidden p-0">
      <div className={ROW}>
        <div className="flex items-center gap-[var(--aura-space-3)]">
          <SkeletonBlock className="size-4" />
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="h-4 w-44 max-sm:hidden" />
        </div>
        <SkeletonBlock className="h-6 w-24 rounded-full" />
      </div>
    </Card>
  );
}

/** Mirrors `EvidenceCard`'s open state — summary row + two sectioned definition grids. */
function ExpandedCardSkeleton(): React.JSX.Element {
  return (
    <Card className="overflow-hidden p-0">
      <div className={`${ROW} border-b border-[var(--aura-border-default)]`}>
        <div className="flex items-center gap-[var(--aura-space-3)]">
          <SkeletonBlock className="size-4" />
          <SkeletonBlock className="h-5 w-40" />
          <SkeletonBlock className="h-4 w-44 max-sm:hidden" />
        </div>
        <SkeletonBlock className="h-6 w-24 rounded-full" />
      </div>
      <div className="flex flex-col gap-[var(--aura-space-5)] p-[var(--aura-space-5)]">
        {[0, 1].map((s) => (
          <div key={s} className="flex flex-col gap-2">
            <SkeletonBlock className="h-4 w-32" />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="h-4 w-40" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.compliance.erasureLog');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />

        <div
          className="flex flex-col gap-[var(--aura-space-3)] sm:flex-row sm:items-end sm:justify-between"
          aria-hidden
        >
          <SkeletonBlock className="h-10 w-80 max-w-full" />
          <div className="flex flex-col gap-1">
            <SkeletonBlock className="h-4 w-40" />
            <div className="flex gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-[var(--aura-input-height)] w-60 max-sm:flex-1" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-24" />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-[var(--page-section-gap)]" aria-hidden>
          <CollapsedCardSkeleton />
          <ExpandedCardSkeleton />
          <CollapsedCardSkeleton />
        </div>
      </TableContainer>
    </PageSkeletonShell>
  );
}
