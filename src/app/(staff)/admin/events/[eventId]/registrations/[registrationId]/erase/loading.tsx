/**
 * F6 Phase 10 T112 — erase-PII page shimmer skeleton.
 */
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';

export default function ErasePiiLoading() {
  return (
    <DetailContainer aria-busy="true">
      <PageHeader
        title={
          <span aria-hidden="true" className="block">
            <Skeleton className="h-7 w-96" />
          </span>
        }
      />
      <Skeleton className="h-4 w-72" aria-hidden />
      <div className="mt-4 flex flex-col gap-3" aria-hidden>
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-5 w-48" />
      </div>
    </DetailContainer>
  );
}
