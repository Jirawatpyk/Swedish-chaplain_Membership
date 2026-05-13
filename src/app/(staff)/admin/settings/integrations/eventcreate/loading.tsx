/**
 * /admin/settings/integrations/eventcreate loading skeleton (T080).
 *
 * Renders a placeholder stepper + card layout while the server
 * component fetches the integration config via
 * `runLoadIntegrationConfig`. Layout pair with the canonical page so
 * `pnpm check:layout` accepts the FormContainer / FormContainer match.
 */
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function EventCreateIntegrationLoading() {
  return (
    <FormContainer>
      <PageHeader
        title={<Skeleton className="h-7 w-56" />}
        subtitle={<Skeleton className="h-4 w-80" />}
      />

      {/* Stepper placeholder */}
      <div className="flex items-start gap-2">
        {[1, 2, 3].map((n) => (
          <div key={n} className="flex flex-1 items-center gap-2">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>

      {/* Phase card placeholder */}
      <Card>
        <CardContent className="flex flex-col gap-4 py-6">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>

      {/* Recent deliveries placeholder */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <Card>
          <CardContent className="space-y-3 py-4">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-3">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-5 flex-1" />
                <Skeleton className="h-5 w-20" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </FormContainer>
  );
}
