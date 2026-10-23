'use client';

/**
 * 124 — the header's two actions: Export CSV (the existing export route for
 * the selected FY, US2.6; every viewer of the page holds `invoicing.read`,
 * which is all the route asks) and View invoices. Below 640px View invoices
 * keeps the row at full width and Export CSV moves into a ⋯ menu, as the
 * mobile board draws it. A download is a plain document request, never a
 * client-side route change, so both entry points use a real navigation.
 */
import Link from 'next/link';
import { DropdownMenu, IconButton, buttonClass } from '@jirawatpyk/aura-react';

export function DashboardHeaderActions({
  exportHref,
  exportLabel,
  viewInvoicesLabel,
  moreLabel,
}: {
  readonly exportHref: string;
  readonly exportLabel: string;
  readonly viewInvoicesLabel: string;
  readonly moreLabel: string;
}) {
  return (
    <>
      <a
        href={exportHref}
        download
        data-testid="dashboard-export-csv"
        className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true, className: 'max-sm:hidden' })}
      >
        {exportLabel}
      </a>
      <Link
        href="/admin/invoices"
        className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true, fullWidth: 'below-sm' })}
      >
        {viewInvoicesLabel}
      </Link>
      <span className="contents sm:hidden">
        <DropdownMenu
          label={moreLabel}
          trigger={<IconButton icon="ellipsis" touchHeight label={moreLabel} />}
          items={[{ label: exportLabel, icon: 'download', onSelect: () => window.location.assign(exportHref) }]}
        />
      </span>
    </>
  );
}
