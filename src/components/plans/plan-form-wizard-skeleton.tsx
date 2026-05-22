import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Colocated skeleton for <PlanFormWizard> (same folder as the real
 * component so drift gets caught at review time).
 *
 * Shape mirrors the initial "basics" step that the wizard renders on
 * first mount:
 *   - 4-item step indicator approximating the canonical `<Stepper>`
 *     primitive (size-7 circles spaced flex-1 with hairline connectors)
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
      {/* Step indicator — 4 steps; mirrors `<Stepper compact>` shape
          (size-7 circle + connector hairlines flex-1) to keep CLS
          minimal when the real wizard hydrates. Labels are hidden in
          compact mode on <sm, so no SkeletonBlock for label slots. */}
      <div className="flex w-full items-start gap-0">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex min-w-0 flex-1 flex-col items-center text-center"
          >
            <div className="flex w-full items-center">
              <span
                aria-hidden="true"
                className={
                  i === 0
                    ? 'h-px flex-1 bg-transparent'
                    : 'h-px flex-1 bg-border'
                }
              />
              <SkeletonBlock className="size-7 shrink-0 rounded-full" />
              <span
                aria-hidden="true"
                className={
                  i === 3
                    ? 'h-px flex-1 bg-transparent'
                    : 'h-px flex-1 bg-border'
                }
              />
            </div>
          </div>
        ))}
      </div>
      {/* Mobile compact-summary placeholder — matches the real wizard's
          `<p className="sm:hidden">Step 2/4 — {label}</p>` so the row
          doesn't pop in on hydrate (CLS-0). */}
      <SkeletonBlock className="mx-auto h-4 w-32 sm:hidden" />
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
