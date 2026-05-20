/**
 * T075 loading skeleton — paired with page.tsx so `pnpm check:layout`
 * passes (every page/loading pair MUST use the same layout container).
 *
 * PR-review fix 2026-05-20 UX-M2 — anatomy matches the rendered page
 * (PageHeader title + description + Allowlist form-row + 4 table rows
 * separated by border-t) instead of the previous 4 identical h-10
 * stubs. Lower CLS when content loads.
 */
import { FormContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <FormContainer>
      {/* PageHeader title + description stub */}
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-3/4 mt-2" />

      {/* Allowlist add-hostname form row */}
      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>

      {/* Allowlist table — 4 row stubs separated by border-t */}
      <div className="mt-4 space-y-0">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 py-3 border-t"
          >
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </FormContainer>
  );
}
