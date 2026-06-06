/**
 * Route-level loading UI for /admin/invoices.
 *
 * async + translated title/subtitle match the pattern used by members,
 * plans, and settings/invoicing. An older sync version was observed to
 * bubble up to the parent /admin/loading.tsx (dashboard skeleton) under
 * Next.js 16 Cache Components because the boundary did not resolve
 * its i18n in time with the async page.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { FilterBar } from '@/components/ui/filter-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

/**
 * Mirrors <InvoicesTable />'s 8-column default layout (Method column is
 * opt-in via `?paidOnline=1` and not reserved at route-load time):
 *   Number · Receipt No. · Buyer · Status · Issued · Due · Total · Actions
 * The Buyer column gets the extra `1.5fr` weight (it carries the name +
 * subtitle, the widest cell in the live table); every other column is an
 * equal `1fr`. Keeping the count + template in sync with the real table
 * is what holds CLS at 0.
 */
const INVOICE_COLUMN_COUNT = 8;
const INVOICE_GRID_TEMPLATE =
  '1fr 1fr 1.5fr 1fr 1fr 1fr 1fr 1fr';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.list');
  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={<Skeleton className="h-9 w-32" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Filter bar skeleton — mirrors <InvoiceFilters /> */}
          <FilterBar aria-hidden>
            <Skeleton className="h-9 min-w-0 sm:flex-1" />
            <Skeleton className="h-9 sm:w-[12rem]" />
          </FilterBar>
          {/* Table skeleton — mirrors <InvoicesTable />'s EXACT column
              set so the shell does NOT shift when the real rows land
              (CLS 0 per ux-standards § 2.1). The standard list renders
              8 columns: Number · Receipt No. · Buyer · Status · Issued ·
              Due · Total · Actions. The Method column is opt-in via
              `?paidOnline=1` and is NOT reserved here — route-level
              loading.tsx cannot read the search param, and the default
              view is the no-Method 8-column layout. The grid template
              mirrors the members-table-skeleton pattern. aria-hidden so
              the placeholder shimmer stays out of the a11y tree.
              `aria-hidden` alone (no `aria-busy` on the same node) matches
              the members-table-skeleton precedent — an aria-hidden subtree
              is removed from the a11y tree, so an `aria-busy` on it would be
              moot. This route's loading.tsx is the Suspense boundary itself,
              so the busy state is signalled by the route transition. */}
          <div className="flex flex-col gap-3" aria-hidden>
            {/* Header row */}
            <div
              className="grid gap-3 border-b bg-muted/40 px-4 py-3"
              style={{ gridTemplateColumns: INVOICE_GRID_TEMPLATE }}
            >
              {Array.from({ length: INVOICE_COLUMN_COUNT }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
            {/* Data rows */}
            {Array.from({ length: 8 }).map((_, r) => (
              <div
                key={r}
                className="grid gap-3 border-b px-4 py-3 last:border-b-0"
                style={{ gridTemplateColumns: INVOICE_GRID_TEMPLATE }}
              >
                {Array.from({ length: INVOICE_COLUMN_COUNT }).map((__, c) => (
                  <Skeleton key={c} className="h-5 w-full" />
                ))}
              </div>
            ))}
          </div>
          {/* Pagination summary skeleton */}
          <div className="flex justify-between">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-9 w-48" />
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
