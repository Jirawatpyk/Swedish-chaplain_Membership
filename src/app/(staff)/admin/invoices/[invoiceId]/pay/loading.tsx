import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default function Loading() {
  return (
    <FormContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-48" />}
        subtitle={<Skeleton className="h-4 w-72" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-[var(--page-section-gap)]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-[var(--field-label-gap)]">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <div className="flex justify-end">
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-4 w-20" />
    </FormContainer>
  );
}
