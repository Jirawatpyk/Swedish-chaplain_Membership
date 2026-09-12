/**
 * Route-level loading UI for /admin/change-requests/[id] — the header in the
 * page's exact shape (title + one subtitle line + the state badge + the
 * back action — the page always renders all four, so the skeleton is not one
 * subtitle line short: PR-1 review, UX M4), a five-row shimmer in the
 * decision table's shape, and the footer's summary + confirm button. Wrapped
 * in `PageSkeletonShell` so assistive tech hears the load (the plain
 * `aria-hidden` skeleton said nothing). Same container as page.tsx
 * (check:layout), CLS 0.
 */
import { getTranslations } from 'next-intl/server';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.changeRequests.review');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer>
        <PageHeader
          title={t('title')}
          subtitle={<SkeletonBlock className="h-4 w-full max-w-md" />}
          badge={<Skeleton className="h-5 w-24 rounded-full" />}
          actions={<Skeleton className="h-9 w-32" />}
        />
        <div className="divide-y divide-border rounded-md border" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_5rem] sm:gap-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-5 sm:justify-self-end" />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between" aria-hidden="true">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-9 w-40" />
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
