/**
 * F9 US4 — shimmer skeleton for the benefit-usage pages (ux-standards § 2.1,
 * CLS = 0). Shared by the member + staff `loading.tsx` so both route-level
 * suspense fallbacks match the rendered card's shape.
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function BenefitUsageSkeleton(): React.ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
              <Skeleton className="h-3 w-40" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
