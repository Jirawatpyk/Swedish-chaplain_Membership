/**
 * Route-level loading UI for /admin/invoices/[invoiceId] — the page's shape
 * on AURA (spec 122 US8b, T827; boards `Admin-invoice-*`): the header with
 * its title, status pill and actions, then the Details card (the fields in
 * two columns, then the totals block) and the Line items card, so the swap
 * to content holds CLS 0. `PageSkeletonShell` is the one live region that
 * announces the load.
 *
 * The title is a skeleton because the real heading depends on the status
 * ("Draft invoice" vs "Invoice SC-2026-000004"). The async shell + i18n load
 * still makes Next.js mount THIS boundary instead of /admin/loading.tsx.
 *
 * The placeholders are plain `<div>`s, never a `<dl>`: the skeleton has no
 * real `<dt>`/`<dd>` pairs (axe `definition-list` / `only-dlitems`, CP-3.8).
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  await getTranslations('admin.invoices.detail');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer aria-busy="true">
        <PageHeader
          title={<SkeletonBlock className="h-8 w-64" />}
          // The status pill beside the title.
          badge={<SkeletonBlock className="h-5 w-20 rounded-full" />}
          actions={
            // Worst-case action set (the draft: Delete draft, Preview, Issue),
            // so the skeleton never understates the header. Below 640px the
            // actions sit in the fixed bar at the foot of the screen.
            <>
              <SkeletonBlock className="h-9 w-28 max-sm:hidden" />
              <SkeletonBlock className="h-9 w-24 max-sm:hidden" />
              <SkeletonBlock className="h-9 w-28 max-sm:hidden" />
            </>
          }
        />
        <div className="flex flex-col gap-[var(--aura-space-5)]" aria-hidden="true">
          {/* Details: the fields, then the totals block. */}
          <Card header={<SkeletonBlock className="h-6 w-24" />}>
            <div className="flex flex-col gap-[var(--aura-space-5)]">
              <div className="grid grid-cols-1 gap-x-[var(--aura-space-6)] gap-y-[var(--aura-space-4)] sm:grid-cols-2">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <SkeletonBlock className="h-3 w-20" />
                    <SkeletonBlock className="h-5 w-40 max-w-full" />
                  </div>
                ))}
              </div>
              <div className="ml-auto flex w-full max-w-xs flex-col gap-[var(--aura-space-2)]">
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-6 w-full" />
              </div>
            </div>
          </Card>
          {/* Line items: the header row and two lines. */}
          <Card header={<SkeletonBlock className="h-6 w-28" />}>
            <div className="flex flex-col gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-8 w-full" />
              <SkeletonBlock className="h-11 w-full" />
              <SkeletonBlock className="h-11 w-full" />
            </div>
          </Card>
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
