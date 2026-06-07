import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * R7-B3 — /portal/invoices loading skeleton.
 *
 * Mirrors the real surface at both breakpoints (CLS-0):
 *   - `≥ md` — the 7-column × 5-row desktop table placeholder (document
 *     number, receipt number, status, issue date, due date, total,
 *     actions).
 *   - `< md` (060-member-portal-d4 Task 4) — a stacked card placeholder
 *     matching `PortalInvoiceCardList`'s real card height: a doc-number
 *     line + status-badge pill (header row), a dates line, a total line,
 *     and an action-button row (h-11 button skeletons).
 *
 * Real translated title + subtitle (not skeletons) to match the settled
 * page header, per the project convention (see
 * /admin/settings/invoicing/loading.tsx).
 */
export default async function Loading() {
  const t = await getTranslations('portal.invoices');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <TableContainer>
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <Card>
          <CardContent className="flex flex-col gap-4">
            {/* Reserve InvoiceFilters shape: search input (flex-1) +
                status select (12rem) — keeps CLS-0 when real form
                paints. */}
            <div className="flex flex-wrap items-end gap-3">
              <SkeletonBlock className="h-9 flex-1 min-w-[10rem]" />
              <SkeletonBlock className="h-9 w-[12rem]" />
            </div>
            {/* Desktop table skeleton (≥ md) — header row + 5 body rows. */}
            <div className="hidden flex-col gap-4 md:flex">
              <div className="grid grid-cols-7 gap-3">
                {Array.from({ length: 7 }).map((_, c) => (
                  <SkeletonBlock key={c} className="h-4 w-20" />
                ))}
              </div>
              {Array.from({ length: 5 }).map((_, r) => (
                <div key={r} className="grid grid-cols-7 gap-3">
                  {Array.from({ length: 7 }).map((_, c) => (
                    <SkeletonBlock key={c} className="h-8 w-full" />
                  ))}
                </div>
              ))}
            </div>
            {/* Mobile card skeleton (< md) — 5 cards, each matching the real
                card height: header (doc# + status pill), dates line, total
                line, action-button row (h-11). Keeps CLS-0 when real cards
                paint. */}
            <ul role="list" className="flex flex-col gap-3 md:hidden">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i}>
                  <Card>
                    <CardContent className="flex flex-col gap-3">
                      <div className="flex items-start justify-between gap-3">
                        <SkeletonBlock className="h-5 w-32" />
                        <SkeletonBlock className="h-6 w-20 rounded-full" />
                      </div>
                      <SkeletonBlock className="h-4 w-56" />
                      <Separator />
                      <SkeletonBlock className="h-6 w-28" />
                      <div className="flex flex-wrap gap-2">
                        <SkeletonBlock className="h-11 w-24" />
                        <SkeletonBlock className="h-11 w-24" />
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </TableContainer>
    </PageSkeletonShell>
  );
}
