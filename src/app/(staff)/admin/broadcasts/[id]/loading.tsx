import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminBroadcastDetailLoading(): React.ReactElement {
  return (
    <DetailContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-80" />
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
    </DetailContainer>
  );
}
