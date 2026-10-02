/**
 * Route-level loading UI for /admin/invoices/new.
 *
 * SHAPE-NEUTRAL (054-event-fee-invoices Task 10/11): the page hosts TWO form
 * shapes (membership vs event-fee) behind a type selector, so a
 * membership-shaped skeleton would flash the wrong layout on the event path
 * (CLS — ux-standards §2.1). This renders the type-selector card + one
 * generic form card; the form-specific placeholders live inside the client
 * components (e.g. `EventAttendeePickerSkeleton`).
 *
 * Spec 122 US8 (T807) — the `Admin-invoice-new` cards on AURA.
 *
 * async + translated header — matches members/new + plans/new pattern so
 * Next.js 16 Cache Components resolves the boundary consistently.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.invoices.new');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader
          title={t('title')}
          subtitle={t('description')}
          // The page's desktop Back button (below 1024px the shell's back link stands in).
          actions={<SkeletonBlock className="h-[var(--aura-button-height)] w-28 max-lg:hidden" />}
        />
        <div className="flex flex-col gap-[var(--aura-space-6)]" aria-hidden>
          {/* "What is this invoice for?" — the radio group's label, then the two options */}
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-3)]">
              <SkeletonBlock className="h-5 w-56" />
              <SkeletonBlock className="h-4 w-28" />
              <div className="grid gap-[var(--aura-space-3)] sm:grid-cols-2">
                <SkeletonBlock className="h-14 w-full" />
                <SkeletonBlock className="h-14 w-full" />
              </div>
            </div>
          </Card>
          {/* The chosen form's first field — neutral between the two shapes */}
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="h-4 w-24" />
              <SkeletonBlock className="h-[var(--aura-input-height)] w-full" />
            </div>
          </Card>
          <div className="flex justify-end gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-11 w-24" />
            <SkeletonBlock className="h-11 w-32" />
          </div>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
