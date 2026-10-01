/**
 * F8 Phase 8 T218 — Route-level loading skeleton for `/admin/renewals/tasks`.
 *
 * 122 US7b-2 (T735): the page's shape on AURA skeleton blocks — one card
 * (frameless on a phone) holding the section tabs, the filter row (status and
 * assignment groups, the task type select) and the queue rows, each ending in
 * Done and the ⋯ button. CLS 0: page and loading both wrap in `TableContainer`
 * (`pnpm check:layout`). The overdue toggle and the manager note depend on
 * data, so they are not drawn.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tasks');
  return (
    <PageSkeletonShell ariaLabel={t('loading')}>
      <TableContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
          <div className="flex flex-col gap-[var(--aura-space-4)]">
            {/* The four section tabs (a Select on a phone). */}
            <div data-slot="tab-strip-skeleton" className="flex items-center gap-[var(--aura-space-4)]" aria-hidden>
              <SkeletonBlock className="h-9 w-full sm:hidden" />
              <SkeletonBlock className="hidden h-6 w-20 sm:block" />
              <SkeletonBlock className="hidden h-6 w-32 sm:block" />
              <SkeletonBlock className="hidden h-6 w-16 sm:block" />
              <SkeletonBlock className="hidden h-6 w-32 sm:block" />
            </div>
            {/* Status and Assignment groups, then the Task type select. */}
            <div data-slot="filters-skeleton" className="flex flex-wrap items-end gap-[var(--aura-space-4)]" aria-hidden>
              <SkeletonBlock className="h-[38px] w-52 rounded-full" />
              <SkeletonBlock className="h-[38px] w-60 rounded-full" />
              <SkeletonBlock className="h-9 w-full sm:w-56" />
            </div>
            {/* Rows: member · tier · expiry · task type · due · assignee ·
                status · Done and ⋯. From 640px a grid; on a phone, bordered
                cards as the queue stacks. */}
            <div className="flex flex-col max-sm:gap-[var(--aura-space-3)]" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <div
                  key={i}
                  className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] p-[var(--aura-space-4)] sm:grid sm:grid-cols-12 sm:items-center sm:gap-[var(--aura-space-4)] sm:rounded-none sm:border-x-0 sm:border-b-0 sm:px-0 sm:py-[var(--aura-space-3)]"
                >
                  <SkeletonBlock className="h-5 w-48 sm:col-span-2 sm:w-full" />
                  <SkeletonBlock className="hidden h-5 w-full sm:col-span-1 sm:block" />
                  <SkeletonBlock className="hidden h-4 w-full sm:col-span-1 sm:block" />
                  <SkeletonBlock className="h-5 w-40 sm:col-span-2 sm:w-full" />
                  <SkeletonBlock className="h-4 w-56 sm:col-span-2 sm:w-full" />
                  <SkeletonBlock className="hidden h-8 w-full sm:col-span-1 sm:block" />
                  <SkeletonBlock className="hidden h-6 w-full sm:col-span-1 sm:block" />
                  <div data-slot="row-actions-skeleton" className="flex gap-[var(--aura-space-2)] sm:col-span-2 sm:justify-end">
                    <SkeletonBlock className="h-11 flex-1 sm:h-8 sm:w-16 sm:flex-none" />
                    <SkeletonBlock className="size-11 sm:size-8" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
