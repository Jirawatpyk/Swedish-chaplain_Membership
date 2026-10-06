/**
 * Route-level loading UI for /admin/directory — shimmer skeleton in the final
 * shape for CLS 0 (ux-standards § 2.1). Mirrors the directory layout: header +
 * two generate actions, the Card-wrapped search filter bar + 7-column directory
 * table (via `DirectoryTableSkeleton`), and the recent-exports section. The
 * Members card is the page's own AURA Card with the same props, so it goes
 * flush on a phone exactly as the loaded card does (no frame, no padding, the
 * heading dropped as the page's is `max-sm:sr-only`) and keeps AURA's padding
 * on desktop; a hand-drawn framed box here shifted the list when data landed. Also
 * provides the Suspense boundary the client `<DirectorySearchFilters>`
 * (`useSearchParams`) needs.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DirectoryTableSkeleton } from '@/components/directory/directory-table-skeleton';

const CARD =
  'flex flex-col gap-4 rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-5 max-sm:p-4';

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('admin.directory');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={
            <>
              {/* On a phone the two generate actions are full-width 44px
                  buttons, one under the other; desktop keeps them inline.
                  `min-w-full`, not `w-full`: the header's `[&>*]:flex-1`
                  zeroes the basis, so only a minimum width makes them wrap
                  the way the real buttons' text does. */}
              <SkeletonBlock className="h-9 w-44 max-sm:h-11 max-sm:min-w-full" />
              <SkeletonBlock className="h-9 w-40 max-sm:h-11 max-sm:min-w-full" />
            </>
          }
        />

        {/* The "Members" card: heading, search + "Listed only", the table.
            Same Card props as the page's (`flushBelow="sm"`, flush on a phone). */}
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0" aria-hidden>
          <div className="flex flex-col gap-4">
            {/* The heading's line box (text-base, 24px); a phone hides it. */}
            <SkeletonBlock className="h-6 w-24 max-sm:hidden" />
            <div className="flex flex-wrap items-center gap-3">
              <SkeletonBlock className="h-9 min-w-[12rem] flex-1" />
              <div className="flex items-center gap-2">
                <SkeletonBlock className="size-4 rounded-[4px]" />
                <SkeletonBlock className="h-4 w-24" />
              </div>
            </div>
            <DirectoryTableSkeleton />
          </div>
        </Card>

        {/* Recent exports — mirrors the populated table (3 visible cols) so the
            shell doesn't jump from a single block to a table when data lands. */}
        <div className={CARD} aria-hidden>
          <SkeletonBlock className="h-5 w-40" />
          {[0, 1, 2].map((r) => (
            <div
              key={r}
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
            >
              {[0, 1, 2].map((c) => (
                <SkeletonBlock key={c} className="h-4 w-full" />
              ))}
            </div>
          ))}
        </div>
      </TableContainer>
    </PageSkeletonShell>
  );
}
