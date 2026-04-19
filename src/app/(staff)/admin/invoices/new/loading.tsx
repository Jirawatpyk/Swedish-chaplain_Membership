import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function Loading() {
  return (
    <FormContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-48" />}
        subtitle={<Skeleton className="h-4 w-64" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-[var(--page-section-gap)]">
          {/* Member combobox skeleton */}
          <div className="flex flex-col gap-[var(--field-label-gap)]">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
          {/* Plan info card skeleton */}
          <div className="rounded-md border p-4 flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
