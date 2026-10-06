/**
 * F6 remediation PR 2.2 / P4 — erase-by-email page skeleton.
 *
 * Spec 122 US9b-1 (T926): the real page's shape on AURA for CLS 0 — the
 * header (real title and hint), then the one card with the search field and
 * its button, and the prompt line below. Renders inside TableContainer, so
 * `pnpm check:layout` accepts the container pair.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function EraseByEmailLoading() {
  const t = await getTranslations('admin.events.erasure');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('pageTitle')} subtitle={t('pageHint')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0" aria-hidden>
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            <div className="flex flex-wrap items-end gap-[var(--aura-space-3)]" data-skeleton="search">
              <div className="flex min-w-[16rem] flex-1 flex-col gap-2">
                <SkeletonBlock className="h-4 w-32" />
                <SkeletonBlock className="h-[var(--aura-input-height)] w-full max-sm:h-11" />
              </div>
              <SkeletonBlock className="h-[var(--aura-input-height)] w-24 max-sm:h-11" />
            </div>
            <SkeletonBlock className="mx-auto my-[var(--aura-space-8)] h-4 w-80 max-w-full" />
            <SkeletonBlock className="h-8 w-32 max-sm:h-11" data-skeleton="back-link" />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
