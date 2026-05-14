/**
 * T098 — /admin/events/import shimmer skeleton (F6 Phase 7).
 *
 * CLS-0 shape — mirrors the CsvMappingForm card layout exactly.
 * Renders inside FormContainer + PageHeader so the layout matches
 * the real page on navigation. Pairs with `page.tsx` per the
 * pnpm check:layout invariant (page + loading use the SAME container).
 */
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function CsvImportLoading() {
  return (
    <FormContainer aria-busy="true">
      <PageHeader
        title={
          <span aria-hidden="true" className="block">
            <Skeleton className="h-7 w-56" />
          </span>
        }
        subtitle={<Skeleton className="h-4 w-72" aria-hidden />}
      />
      <Card aria-hidden>
        <CardHeader className="flex flex-col gap-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* File-input area shimmer */}
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-3 w-64" />
          {/* Primary + secondary CTA pair — mirrors PreviewPanel
              `<Button>` layout (min-h-11 for WCAG 2.5.8 tap target)
              so CLS-0 holds when the loading state swaps for the
              real form. */}
          <div className="flex gap-2">
            <Skeleton className="h-11 w-44 rounded-lg" />
            <Skeleton className="h-11 w-24 rounded-lg" />
          </div>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
