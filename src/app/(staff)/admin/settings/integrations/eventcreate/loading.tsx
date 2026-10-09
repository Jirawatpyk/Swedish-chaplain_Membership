/**
 * /admin/settings/integrations/eventcreate loading skeleton (T080).
 *
 * Spec 122 US9c — AURA skeleton in the page's own frame (`FormContainer`
 * + the real page header, so `pnpm check:layout` pairs it with page.tsx):
 * a three-step stepper shape (only the "Step n of 3" line on phones, as
 * AURA's Stepper), the value-box card and the recent-deliveries card.
 * `PageSkeletonShell` announces the loading state; the blocks are hidden
 * from assistive tech.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function EventCreateIntegrationLoading() {
  const t = await getTranslations('admin.integrations.eventcreate.page');
  return (
    <PageSkeletonShell ariaLabel={t('loading')}>
      <FormContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <div aria-hidden className="flex flex-col gap-[var(--aura-space-5)]">
          <div className="flex items-center gap-[var(--aura-space-2)] max-sm:hidden" data-skeleton="stepper">
            {[0, 1, 2].map((n) => (
              <div key={n} className={n < 2 ? 'flex flex-1 items-center gap-[var(--aura-space-2)]' : 'flex items-center gap-[var(--aura-space-2)]'}>
                <SkeletonBlock className="size-7 shrink-0 rounded-full" />
                <SkeletonBlock className="h-4 w-24" />
                {n < 2 ? <span className="h-px flex-1 bg-[var(--aura-border-subtle)]" /> : null}
              </div>
            ))}
          </div>
          <SkeletonBlock className="h-4 w-40 sm:hidden" />
          <SkeletonBlock className="h-12 w-full rounded-[var(--aura-radius-lg)]" />
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-4)]">
              {[0, 1].map((n) => (
                <div key={n} className="flex flex-col gap-[var(--aura-space-2)]">
                  <SkeletonBlock className="h-4 w-28" />
                  <SkeletonBlock className="h-10 w-full" />
                </div>
              ))}
              <SkeletonBlock className="h-9 w-40 max-sm:h-11 max-sm:w-full" />
            </div>
          </Card>
          <Card>
            <div className="flex flex-col gap-[var(--aura-space-4)]">
              <SkeletonBlock className="h-6 w-40" />
              <SkeletonBlock className="h-5 w-52" />
              {[0, 1, 2].map((n) => (
                <SkeletonBlock key={n} className="h-8 w-full" />
              ))}
            </div>
          </Card>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
