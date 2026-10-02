/**
 * F8 Phase 8 T218 — Route-level loading skeleton for `/admin/renewals/tasks`.
 *
 * 122 US7b-2 (T735): the page's shape on AURA skeleton blocks — one card
 * (frameless on a phone) holding the section tabs, the filter row (status and
 * assignment groups, the task type select) and the queue: AURA's `DataTable`
 * in its loading state with the queue's columns
 * (`escalation-task-queue-columns.ts`), edge to edge inside the card. CLS 0: page and loading both wrap in `TableContainer`
 * (`pnpm check:layout`). The overdue toggle and the manager note depend on
 * data, so they are not drawn.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import {
  ESCALATION_TASK_COLUMN_LAYOUT,
  type EscalationTaskColumnKey,
} from './_components/escalation-task-queue-columns';

const LABEL_KEYS = {
  member: 'columns.member',
  tier: 'columns.tier',
  expiresAt: 'columns.expiresAt',
  taskType: 'columns.taskType',
  dueAt: 'columns.dueAt',
  assignedTo: 'columns.assignedTo',
  status: 'columns.status',
  actions: null,
} as const satisfies Record<EscalationTaskColumnKey, string | null>;

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tasks');
  const columns = (Object.keys(ESCALATION_TASK_COLUMN_LAYOUT) as EscalationTaskColumnKey[]).map((key) => {
    const labelKey = LABEL_KEYS[key];
    return { key, label: labelKey === null ? '' : t(labelKey), ...ESCALATION_TASK_COLUMN_LAYOUT[key] };
  });
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
            {/* The queue as the page draws it (rows stack into cards below
                640px), edge to edge inside the card; "Next 50" can follow it. */}
            <DataTableSkeleton label={t('table_caption')} columns={columns} rows={8} />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
