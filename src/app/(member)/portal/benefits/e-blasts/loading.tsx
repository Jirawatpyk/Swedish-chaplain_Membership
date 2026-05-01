import { DetailContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function EblastsListLoading(): React.ReactElement {
  return (
    <DetailContainer>
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-72" />
      </header>
      <Skeleton className="mt-6 h-32 w-full" />
      <Skeleton className="mt-3 h-3 w-56" />
      <div className="mt-6 space-y-2">
        {/* 10 rows to match `PER_PAGE` in page.tsx — prevents CLS when
            data hydrates (ux-standards.md § 2.1 Skeleton parity). */}
        {Array.from({ length: 10 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </DetailContainer>
  );
}
