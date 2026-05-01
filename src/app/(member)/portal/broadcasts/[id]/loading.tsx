/**
 * F7 US3 T134 — Member broadcast detail loading skeleton.
 */
import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function BroadcastDetailLoading(): React.ReactElement {
  return (
    <DetailContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </header>
      <Skeleton className="mt-3 h-8 w-32" />
      <Skeleton className="mt-6 h-40 w-full" />
      <Skeleton className="mt-6 h-32 w-full" />
    </DetailContainer>
  );
}
