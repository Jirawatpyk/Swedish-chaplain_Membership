/**
 * 122 US6 (T602, T609) — the plans list page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=plans`), so the
 * screenshots show the page itself, never a copy of its layout. Board
 * `Admin-plans` (+ `-mobile`): the header with "Clone year" and "New plan",
 * then the table in one card. The page wraps it in its own `TableContainer`
 * (check:layout reads the page file).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { PlusIcon, CopyIcon } from 'lucide-react';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';

export interface PlansListViewProps {
  /** `plans.write`: the header's Clone and New actions. */
  readonly canWrite: boolean;
  /** The table, or the load error in its place. */
  readonly children: ReactNode;
}

export async function renderPlansListView({ canWrite, children }: PlansListViewProps) {
  const t = await getTranslations('admin.plans');
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('listDescription')}
        actions={
          canWrite ? (
            <>
              {/* AURA buttons as the `Admin-plans` board draws them; on a
                  phone "New plan" comes first (`-mobile`). */}
              <Link href="/admin/plans/clone" className={buttonClass({ variant: 'secondary' })}>
                <CopyIcon aria-hidden="true" className="size-4" />
                {t('actions.cloneYear')}
              </Link>
              <Link
                href="/admin/plans/new"
                className={buttonClass({ variant: 'primary', className: 'max-sm:order-first' })}
              >
                <PlusIcon aria-hidden="true" className="size-4" />
                {t('actions.new')}
              </Link>
            </>
          ) : null
        }
      />

      {/* One card on a desktop; on a phone the rows are cards of their own,
          so this one drops its frame (AURA `flushBelow`) and its 16px phone
          padding, putting them on the page gutter as `Admin-plans-mobile`
          and the members list do. */}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        {children}
      </Card>
    </>
  );
}
