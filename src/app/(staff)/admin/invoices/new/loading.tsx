/**
 * Route-level loading UI for /admin/invoices/new.
 *
 * SHAPE-NEUTRAL (054-event-fee-invoices Task 10/11): the page now hosts TWO
 * form shapes (membership vs event-fee) behind a type selector, so a
 * membership-shaped skeleton would flash the wrong layout on the event path
 * (CLS — ux-standards §2.1). This renders only the type-selector radiogroup
 * shape + a generic field block; the form-specific shimmer lives inside the
 * client components (e.g. `EventAttendeePickerSkeleton`).
 *
 * async + translated header — matches members/new + plans/new pattern so
 * Next.js 16 Cache Components resolves the boundary consistently.
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
          {/* Invoice-type selector skeleton (2 radio cards) */}
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-16 w-full rounded-md" />
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
          </div>
          {/* Generic first-field block — neutral between the two form shapes */}
          <div className="flex flex-col gap-[var(--field-label-gap)]">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-9 w-32" />
          </div>
        </CardContent>
      </Card>
    </FormContainer>
  );
}
