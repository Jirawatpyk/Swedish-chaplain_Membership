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
        <CardContent className="flex flex-col gap-6">
          {/* UX-C-4 (Round 1) — EventPicker block renders ABOVE the
              file input in CsvMappingForm. CLS-0 requires the
              skeleton to match: label + combobox trigger (h-11) +
              help text + refresh button row. */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-11 w-full rounded-md" />
            <Skeleton className="h-3 w-80" />
            <div className="flex flex-row gap-2">
              <Skeleton className="h-9 w-36 rounded-md" />
              <Skeleton className="h-9 w-9 rounded-md" />
            </div>
          </div>
          {/* File-input area shimmer */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-3 w-64" />
          </div>
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
