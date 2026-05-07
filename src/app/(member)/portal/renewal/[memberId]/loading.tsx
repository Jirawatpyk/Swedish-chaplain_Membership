/**
 * F8 Phase 5 Wave C · T126 — loading skeleton for the renewal portal page.
 *
 * Rendered by Next.js while the page server component fetches the
 * cycle summary. Mirrors the page's Card layout to avoid layout shift
 * on hydration. Shimmer follows `docs/ux-standards.md § 2.1`.
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function RenewalPortalLoading() {
  return (
    <DetailContainer>
      <header>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-2 h-4 w-72" />
      </header>
      <section className="rounded-lg border bg-card p-4">
        <Skeleton className="mb-3 h-6 w-32" />
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="contents">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-lg border bg-card p-4">
        <Skeleton className="mb-3 h-6 w-40" />
        <Skeleton className="h-4 w-full" />
      </section>
      <Skeleton className="h-10 w-32" />
    </DetailContainer>
  );
}
