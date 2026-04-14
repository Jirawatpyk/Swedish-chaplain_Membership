import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Colocated skeleton for <PlanFormWizard> (same folder as the real
 * component so drift gets caught at review time).
 *
 * Shape mirrors the initial "basics" step that the wizard renders on
 * first mount:
 *   - 4-item step indicator ("1. Basics · 2. Fees · 3. Benefits · 4. Review")
 *   - Separator line
 *   - "Basics" section: h2 + 2-column grid (plan_id, plan_year,
 *     plan_category, member_type_scope) + full-width plan_name label
 *     + full-width description textarea + sort_order with helper text
 *   - Footer: single right-aligned "Next" button (Back only appears
 *     from step 2 onward; Submit only on "review" step)
 *
 * Used by route-level `loading.tsx` at `/admin/plans/new` and
 * `/admin/plans/[year]/[planId]/edit` — both mount the real wizard.
 */
export function PlanFormWizardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      {/* Step indicator — 4 steps */}
      <div className="flex items-center gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-4 w-24" />
        ))}
      </div>
      {/* Separator */}
      <div className="border-t border-border" />
      {/* Basics section */}
      <section className="space-y-4">
        <SkeletonBlock className="h-6 w-24" />
        {/* 2-column grid: plan_id, plan_year, plan_category, member_type_scope */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1">
            <SkeletonBlock className="h-4 w-24" />
            <SkeletonBlock className="h-[var(--input-height)] w-full" />
            <SkeletonBlock className="h-3 w-48" />
          </div>
          <div className="space-y-1">
            <SkeletonBlock className="h-4 w-20" />
            <SkeletonBlock className="h-[var(--input-height)] w-full" />
          </div>
          <div className="space-y-1">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-[var(--input-height)] w-full" />
          </div>
          <div className="space-y-1">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-[var(--input-height)] w-full" />
          </div>
        </div>
        {/* plan_name (LocaleTextInput) — approximated as a single row */}
        <div className="space-y-1">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-[var(--input-height)] w-full" />
        </div>
        {/* description (LocaleTextInput multiline) — textarea height */}
        <div className="space-y-1">
          <SkeletonBlock className="h-4 w-28" />
          <SkeletonBlock className="h-24 w-full" />
        </div>
        {/* sort_order + helper text */}
        <div className="space-y-1">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-[var(--input-height)] w-full" />
          <SkeletonBlock className="h-3 w-48" />
        </div>
      </section>
      {/* Footer — "Next" button right-aligned (basics step has no Back) */}
      <div className="flex items-center justify-end gap-2">
        <SkeletonBlock className="h-9 w-20" />
      </div>
    </div>
  );
}
