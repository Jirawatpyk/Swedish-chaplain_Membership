/**
 * F8 Phase 7 review-fix C-UX-1 + WP8 — Route-level loading skeleton for
 * `/admin/renewals/tier-upgrades`.
 *
 * 122 US7b-1 (T726): the live page renders the section tabs and the queue in
 * one AURA card that is frameless on a phone, so the skeleton draws the same
 * card: a static tab strip (the live `RenewalsSectionTabs` calls
 * `useSearchParams()` and cannot render in a route-level `loading.tsx`), then
 * AURA's `DataTable` in its loading state with the queue's columns
 * (`tier-upgrade-queue-columns.ts`), edge to edge and ending the card as the
 * queue does (`bleed`, `bleedEnd`).
 * `PageSkeletonShell` is the one live region that announces the load.
 *
 * Wrapped in `<TableContainer>` so the `pnpm check:layout` invariant (page +
 * loading both use the same variant) holds.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';
import { DataTableSkeleton } from '@/components/shell/data-table-skeleton';
import {
  TIER_UPGRADE_COLUMN_LAYOUT,
  type TierUpgradeColumnKey,
} from './_components/tier-upgrade-queue-columns';

const LABEL_KEYS = {
  member: 'columns.member',
  fromPlan: 'columns.from_plan',
  toPlan: 'columns.to_plan',
  reason: 'columns.reason',
  status: 'columns.status',
  actions: null,
} as const satisfies Record<TierUpgradeColumnKey, string | null>;

export default async function Loading() {
  const t = await getTranslations('admin.renewals.tier_upgrades');
  const columns = (Object.keys(TIER_UPGRADE_COLUMN_LAYOUT) as TierUpgradeColumnKey[]).map((key) => {
    const labelKey = LABEL_KEYS[key];
    return { key, label: labelKey === null ? '' : t(labelKey), ...TIER_UPGRADE_COLUMN_LAYOUT[key] };
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
            {/* The phone's "Fees exclude VAT." caption above the cards. */}
            <SkeletonBlock className="h-3 w-32 sm:hidden" />
            {/* The queue as the page draws it (rows stack into cards below
                640px), edge to edge and ending the card like the queue. */}
            <DataTableSkeleton label={t('tableCaption')} columns={columns} rows={6} bleedEnd />
          </div>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
