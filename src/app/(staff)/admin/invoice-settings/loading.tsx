import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
        <CardHeader>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="mt-2 h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-6">
          {Array.from({ length: 5 }).map((_, section) => (
            <div key={section} className="space-y-4">
              <Skeleton className="h-4 w-32" />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {Array.from({ length: 2 }).map((_, field) => (
                  <div key={field} className="space-y-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <Skeleton className="h-11 w-full" />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
