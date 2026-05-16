/**
 * T046 (F6.1 · Feature 013 — Phase 5 US5) — history page shimmer.
 *
 * CLS-0 shape — mirrors `CsvImportHistoryTable` layout exactly so the
 * skeleton swap on real render does not move the page. Uses the
 * SAME `TableContainer` as page.tsx (006-layout `pnpm check:layout`
 * invariant).
 */
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';

// ux I1 (R1 — enterprise-ux-designer): 10 rows match the viewport-visible
// count for a 30-row page so the skeleton ⇄ real-data swap minimises CLS
// (rows below the fold are below the swap boundary and don't affect LCP).
const SKELETON_ROW_COUNT = 10;

export default function CsvImportHistoryLoading() {
  return (
    <TableContainer aria-busy="true">
      <PageHeader
        title={<Skeleton className="h-7 w-56" aria-hidden />}
        subtitle={<Skeleton className="h-4 w-80" aria-hidden />}
      />
      <div className="flex flex-col gap-4" aria-hidden>
        {/* Table header shimmer */}
        <div className="grid grid-cols-8 gap-3 border-b py-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        {/* Body row shimmers */}
        {Array.from({ length: SKELETON_ROW_COUNT }).map((_, i) => (
          <div key={i} className="grid grid-cols-8 gap-3 py-3">
            {Array.from({ length: 8 }).map((__, j) => (
              <Skeleton key={j} className="h-5 w-full" />
            ))}
          </div>
        ))}
        {/* Pagination shimmer */}
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-4 w-40" />
          <div className="flex gap-2">
            <Skeleton className="h-11 w-28 rounded-lg" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-11 w-24 rounded-lg" />
          </div>
        </div>
      </div>
    </TableContainer>
  );
}
