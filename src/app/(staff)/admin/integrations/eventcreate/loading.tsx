/**
 * Placeholder shimmer for /admin/integrations/eventcreate (Phase 4 verify-fix F4).
 * Replaced by canonical Phase 5 T080 loading.tsx when the wizard lands.
 */
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventCreateIntegrationPlaceholderLoading() {
  return (
    <FormContainer>
      <Skeleton className="h-7 w-32 self-start" />
      <PageHeader
        title={<Skeleton className="h-7 w-56" />}
        subtitle={<Skeleton className="h-4 w-72" />}
      />
      <Card>
        <CardContent className="flex flex-col gap-4 py-12 text-center">
          <Skeleton className="mx-auto h-6 w-40" />
          <Skeleton className="mx-auto h-4 w-80" />
        </CardContent>
      </Card>
    </FormContainer>
  );
}
