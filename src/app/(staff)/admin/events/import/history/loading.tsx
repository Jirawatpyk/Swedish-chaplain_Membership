/**
 * T046 (F6.1 · Feature 013 — Phase 5 US5) — history page skeleton.
 *
 * Spec 122 US9b-2 (T938): the real page's shape on AURA for CLS 0 — the
 * header (real title, subtitle and the back action), the polling row, the
 * table's header band and rows, and the pagination row. Uses the SAME
 * `TableContainer` as page.tsx (`pnpm check:layout` invariant).
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

// ux I1 (R1 — enterprise-ux-designer): 10 rows match the viewport-visible
// count for a 30-row page so the skeleton ⇄ real-data swap minimises CLS.
const SKELETON_ROW_COUNT = 10;

export default async function CsvImportHistoryLoading() {
  const t = await getTranslations('admin.events.import.history');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingTable')}>
      <TableContainer aria-busy="true">
        <PageHeader
          title={t('pageTitle')}
          subtitle={t('pageSubtitle')}
          actions={<SkeletonBlock className="h-[var(--aura-button-height)] w-36" />}
        />
        <div className="flex flex-col gap-[var(--aura-space-3)]" aria-hidden>
          <div className="min-h-[1.5rem]" />
          <div className="overflow-hidden rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]">
            <div className="flex gap-[var(--aura-space-4)] border-b border-[var(--aura-border-default)] bg-[var(--aura-bg-surface-strong)] px-[var(--aura-space-4)] py-[var(--aura-space-3)]">
              {Array.from({ length: 6 }).map((_, i) => (
                <SkeletonBlock key={i} className="h-3 flex-1" />
              ))}
            </div>
            {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
              <div
                key={i}
                className="flex gap-[var(--aura-space-4)] border-b border-[var(--aura-border-subtle)] px-[var(--aura-space-4)] py-[var(--aura-space-3)] last:border-b-0"
              >
                {Array.from({ length: 6 }).map((__, j) => (
                  <SkeletonBlock key={j} className="h-4 flex-1" />
                ))}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-4 w-40" />
            <div className="flex items-center gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-8 w-28 max-sm:h-11" />
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-8 w-24 max-sm:h-11" />
            </div>
          </div>
        </div>
      </TableContainer>
    </PageSkeletonShell>
  );
}
