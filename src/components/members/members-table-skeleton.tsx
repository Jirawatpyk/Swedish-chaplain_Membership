'use client';

/**
 * Loading skeleton for the members table (122 US5a).
 *
 * AURA's own `DataTable` in its loading state, with the real table's columns
 * (same keys, sizes, narrow-table hiding and phone-card breakpoint from
 * `members-table-columns`), so the grid that replaces it lands in the same
 * place: CLS 0 (ux-standards § 2.1). `withSelection` adds the checkbox
 * column the admin table has; the route-level `loading.tsx` runs before the
 * role is known and leaves it off, the page's own Suspense passes the role.
 *
 * 15 skeleton rows fill most laptop viewports, so the pagination below
 * moves only below the fold when the page's 50 rows arrive.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
import { MEMBERS_COLUMN_ORDER, MEMBERS_COLUMN_SIZES } from './members-table-columns';

const LABEL_KEYS = {
  company_name: 'columns.company',
  member_number_display: 'columns.memberNumber',
  primary_contact: 'columns.primaryContact',
  plan_display_name: 'columns.plan',
  status: 'columns.status',
  engagement: 'columns.engagement',
  last_activity_at: 'columns.lastActivity',
  actions: null,
} as const satisfies Record<(typeof MEMBERS_COLUMN_ORDER)[number], string | null>;

interface MembersTableSkeletonProps {
  /** The admin table's leading checkbox column. Default `false` (manager, and first paint before the role is known). */
  readonly withSelection?: boolean;
}

export function MembersTableSkeleton({ withSelection = false }: MembersTableSkeletonProps = {}) {
  const t = useTranslations('admin.members.directory');
  const columns = useMemo<DataTableColumn[]>(
    () =>
      MEMBERS_COLUMN_ORDER.map((key) => {
        const labelKey = LABEL_KEYS[key];
        return {
          key,
          label: labelKey === null ? '' : t(labelKey),
          ...MEMBERS_COLUMN_SIZES[key],
          ...(key === 'actions' ? { actions: true } : {}),
          ...(key === 'status' ? { pill: true } : {}),
        };
      }),
    [t],
  );
  return (
    <div aria-hidden>
      <DataTable
        label={t('tableCaption')}
        rows={[]}
        columns={columns}
        rowKey="member_id"
        loading
        skeletonRows={15}
        selectable={withSelection}
        stackBelow={640}
      />
    </div>
  );
}
