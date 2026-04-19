/**
 * Route-level loading UI for /admin/invoices/[invoiceId].
 *
 * async + translated header — boundary-consistency fix (see adjacent
 * invoices/loading.tsx comment).
 *
 * Title is a skeleton because the real heading is status-specific
 * ("Draft invoice" vs a document number like "SC-2026-000004") — we
 * can't render it deterministically until the detail page resolves.
 * The async shell + i18n load still ensures Next.js mounts THIS
 * boundary instead of bubbling up to /admin/loading.tsx.
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  // Touch the namespace so it's resolved at boundary mount — even
  // though we don't render a literal string, this forces the shell to
  // be treated as async-ready alongside the page.
  await getTranslations('admin.invoices.detail');
  return (
    <DetailContainer>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-6 w-20 rounded-4xl" />
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* 2-column DL grid skeleton */}
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-full" />
              </div>
            ))}
          </dl>
          {/* Lines table skeleton */}
          <section className="mt-6 flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
