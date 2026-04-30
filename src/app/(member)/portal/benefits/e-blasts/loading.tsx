import { TableContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function EblastsListLoading(): React.ReactElement {
  return (
    <TableContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </header>
      <Skeleton className="h-32 w-full" />
      <div className="space-y-2">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </TableContainer>
  );
}
