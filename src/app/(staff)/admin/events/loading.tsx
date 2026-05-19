/**
 * T065 — /admin/events list page shimmer skeleton (F6 Phase 4).
 *
 * CLS-0 shape — mirrors EventsListTable's 6-column header + 8 row
 * shape exactly. Renders inside TableContainer + PageHeader so the
 * layout matches the real page on navigation.
 *
 * Title + subtitle render at REAL text (not Skeleton bars) per the
 * /speckit-review follow-up 2026-05-18 — other admin loading pages
 * (members, invoices, plans, renewals) all render the real header
 * text via `getTranslations`. The previous Skeleton bars over the
 * heading were inconsistent and gave a "still loading" impression
 * even for the static parts of the layout.
 */
import { getTranslations } from 'next-intl/server';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default async function EventsListLoading() {
  const t = await getTranslations('admin.events.list');
  return (
    <TableContainer aria-busy="true">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        // "Import CSV" CTA in PageHeader actions — admin-only button
        // rendered by the real page. Skeleton placeholder keeps CLS-0
        // when the page swaps in.
        actions={<Skeleton className="h-9 w-32 rounded-lg" aria-hidden />}
      />
      <Card aria-hidden>
        <CardContent className="flex flex-col gap-4">
          <div className="flex gap-2" aria-hidden>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-32" />
            ))}
          </div>
          <div className="flex flex-col gap-2" aria-hidden>
            <div className="grid grid-cols-6 gap-3 border-b bg-muted/40 px-4 py-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
            {Array.from({ length: 8 }).map((_, r) => (
              <div
                key={r}
                className="grid grid-cols-6 gap-3 border-b px-4 py-3 last:border-b-0"
              >
                {Array.from({ length: 6 }).map((__, c) => (
                  <Skeleton key={c} className="h-5 w-full" />
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </TableContainer>
  );
}
