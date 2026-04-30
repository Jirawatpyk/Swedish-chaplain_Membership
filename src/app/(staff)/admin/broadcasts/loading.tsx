import { TableContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminBroadcastsLoading(): React.ReactElement {
  return (
    <TableContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96" />
      </header>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-12 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </TableContainer>
  );
}
