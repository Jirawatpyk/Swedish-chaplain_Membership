import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function Loading() {
  return (
    <DetailContainer>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-6 w-20 rounded-4xl" />
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* 2-column DL grid skeleton */}
          <dl className="grid grid-cols-2 gap-4 text-sm">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-full" />
              </div>
            ))}
          </dl>
          {/* Lines table skeleton */}
          <section className="mt-6 flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </section>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
