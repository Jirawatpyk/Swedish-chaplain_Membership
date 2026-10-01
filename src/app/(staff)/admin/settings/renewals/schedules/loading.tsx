/**
 * F8 Phase 4 Wave I1b · T086 — Route-level loading skeleton for
 * `/admin/settings/renewals/schedules`. Matches editor shape (5 tab
 * triggers + 3 step-row placeholders) so layout shifts are minimal
 * (CLS=0 per docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<FormContainer>` so `pnpm check:layout` invariant
 * (page+loading both use the same variant) holds.
 *
 * 122 US7b-2 (T738): the editor's shape on AURA skeleton blocks — tier tabs,
 * the tier heading and chart, step cards, then the save bar.
 */

import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function Loading() {
  const t = await getTranslations('admin.renewals.settings.schedules');
  return (
    <PageSkeletonShell ariaLabel={t('title')}>
      <FormContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <div className="flex flex-col gap-[var(--aura-space-4)]" aria-hidden>
          {/* The five tier tabs. */}
          <div data-slot="tabs-skeleton" className="flex gap-[var(--aura-space-4)] overflow-hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <SkeletonBlock key={i} className="h-6 w-20 shrink-0" />
            ))}
          </div>
          {/* The tier heading, the chart and its legend. */}
          <div data-slot="chart-skeleton" className="flex flex-col gap-[var(--aura-space-2)]">
            <SkeletonBlock className="h-5 w-24" />
            <SkeletonBlock className="h-20 w-full" />
            <SkeletonBlock className="h-3 w-28" />
          </div>
          {/* Step cards: timing and three icon buttons, then channel and timing. */}
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              data-slot="step-skeleton"
              className="flex flex-col gap-[var(--aura-space-3)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] p-[var(--aura-space-4)]"
            >
              <div className="flex items-center justify-between">
                <SkeletonBlock className="h-5 w-40" />
                <div className="flex gap-[var(--aura-space-1)]">
                  <SkeletonBlock className="size-8" />
                  <SkeletonBlock className="size-8" />
                  <SkeletonBlock className="size-8" />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-[var(--aura-space-3)] sm:grid-cols-2">
                <SkeletonBlock className="h-14 w-full" />
                <SkeletonBlock className="h-14 w-full" />
              </div>
            </div>
          ))}
          {/* The save bar: status, Add step, Save schedule. */}
          <div data-slot="save-bar-skeleton" className="flex flex-wrap items-center justify-between gap-[var(--aura-space-3)]">
            <SkeletonBlock className="h-4 w-48" />
            <div className="flex gap-[var(--aura-space-2)]">
              <SkeletonBlock className="h-9 w-28" />
              <SkeletonBlock className="h-9 w-32" />
            </div>
          </div>
        </div>
      </FormContainer>
    </PageSkeletonShell>
  );
}
