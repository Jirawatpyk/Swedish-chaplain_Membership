import { Card } from '@jirawatpyk/aura-react/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Colocated skeleton for <PlanEditForm> — the FLAT edit form, not the
 * 4-step wizard (`PlanFormWizardSkeleton` stays for /admin/plans/new).
 *
 * Shape mirrors plan-edit-form.tsx:
 *   - Basics: h2 + plan name + description (EN/TH/SV tabs + input /
 *     textarea) + 2-column grid (sort order, member type)
 *   - Fees: h2 + annual fee (input with its THB suffix + VAT hint) +
 *     2-column grid (min/max turnover, max duration, max member age)
 *   - Benefits: h2 + the benefit matrix editor's always-present sections
 *     (Brand Visibility, Events, Additional). The Partnership section only
 *     exists for partnership plans, so it is not reserved here.
 *   - Footer: right-aligned Cancel + Save changes
 * The prior-year lock banner is left out — it only shows on past years.
 */
function FieldSkeleton({ labelWidth = 'w-24' }: { readonly labelWidth?: string }) {
  return (
    <div className="space-y-1">
      <SkeletonBlock className={`h-4 ${labelWidth}`} />
      <SkeletonBlock className="h-[var(--input-height)] w-full" />
    </div>
  );
}

function LocaleFieldSkeleton({ multiline = false }: { readonly multiline?: boolean }) {
  return (
    <div className="space-y-2">
      <SkeletonBlock className="h-4 w-24" />
      <SkeletonBlock className="h-9 w-36" />
      <SkeletonBlock className={multiline ? 'h-24 w-full' : 'h-[var(--input-height)] w-full'} />
    </div>
  );
}

function MoneyFieldSkeleton({ withHint = false }: { readonly withHint?: boolean }) {
  return (
    <div className="space-y-1">
      <SkeletonBlock className="h-4 w-28" />
      <SkeletonBlock className="h-[var(--input-height)] w-full" />
      {withHint ? <SkeletonBlock className="h-3 w-48" /> : null}
    </div>
  );
}

function SwitchRowSkeleton() {
  return (
    <div className="flex items-center justify-between gap-4">
      <SkeletonBlock className="h-4 w-40" />
      <SkeletonBlock className="h-5 w-9 rounded-full" />
    </div>
  );
}

export function PlanEditFormSkeleton() {
  return (
    // 122 US6 (T608): the edit form's three AURA cards, then its footer.
    <div className="space-y-6" aria-busy="true">
      <Card header={<SkeletonBlock className="h-6 w-28" />}>
      <section className="space-y-4" data-skeleton-section="basics">
        <LocaleFieldSkeleton />
        <LocaleFieldSkeleton multiline />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FieldSkeleton />
          <FieldSkeleton labelWidth="w-32" />
        </div>
      </section>
      </Card>
      <Card header={<SkeletonBlock className="h-6 w-28" />}>
      <section className="space-y-4" data-skeleton-section="fees">
        <MoneyFieldSkeleton withHint />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <MoneyFieldSkeleton />
          <MoneyFieldSkeleton />
          <FieldSkeleton labelWidth="w-36" />
          <FieldSkeleton labelWidth="w-32" />
        </div>
      </section>
      </Card>
      <Card header={<SkeletonBlock className="h-6 w-32" />}>
      <section className="space-y-4" data-skeleton-section="benefits">
        <div className="space-y-3">
          <SkeletonBlock className="h-4 w-36" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldSkeleton labelWidth="w-28" />
            <FieldSkeleton labelWidth="w-32" />
            <FieldSkeleton labelWidth="w-36" />
            <FieldSkeleton labelWidth="w-36" />
          </div>
        </div>
        <div className="space-y-3">
          <SkeletonBlock className="h-4 w-20" />
          <FieldSkeleton labelWidth="w-36" />
          <SwitchRowSkeleton />
          <FieldSkeleton labelWidth="w-40" />
        </div>
        <div className="space-y-3">
          <SkeletonBlock className="h-4 w-40" />
          <SwitchRowSkeleton />
          <SwitchRowSkeleton />
          <SwitchRowSkeleton />
        </div>
      </section>
      </Card>
      <div className="flex items-center justify-end gap-2" data-skeleton="footer">
        <SkeletonBlock className="h-9 w-20" />
        <SkeletonBlock className="h-9 w-32" />
      </div>
    </div>
  );
}
