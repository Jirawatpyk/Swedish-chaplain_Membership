/**
 * Route-level loading UI for /admin/invoices/new.
 *
 * async + translated header — matches members/new + plans/new pattern
 * so Next.js 16 Cache Components resolves the boundary consistently
 * (see adjacent invoices/loading.tsx note).
 */
import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.new');
  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
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
