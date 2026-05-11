/**
 * `/portal/preferences/renewals` — loading skeleton.
 *
 * Mirrors the real page's `<FormContainer>` shell + `<header>` + a
 * single skeleton block for the renewal-reminders toggle row. Required
 * by `pnpm check:layout` (every migrated page.tsx must have a sibling
 * loading.tsx using the SAME container variant per FR-007 / 006-layout-
 * container-tier2).
 */
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('portal.preferences.renewals');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <header>
          <h1 className="text-2xl font-semibold">{t('title')}</h1>
          <SkeletonBlock className="mt-2 h-4 w-72" />
        </header>
        <section className="rounded-lg border bg-card p-4">
          <SkeletonBlock className="h-6 w-1/2" />
          <SkeletonBlock className="mt-3 h-10 w-40" />
        </section>
      </FormContainer>
    </PageSkeletonShell>
  );
}
