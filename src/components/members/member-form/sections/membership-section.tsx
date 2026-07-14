'use client';

/**
 * MemberForm — Membership section (plan, plan year, registration date).
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4). Split out of the original "Company" `<fieldset>` into its own
 * labelled group — the plan/year/registration-date trio is conceptually
 * distinct from the company particulars, and no existing test asserts the
 * fieldset boundary (verified before this split). Adds i18n key
 * `admin.members.create.sections.membership` (EN/TH/SV) for the new legend.
 *
 * `onPlanIdChange` reports the selected plan up to the composition root,
 * which needs it BEFORE `useForm()` is constructed (to rebuild the zod
 * schema with the plan's conditional DOB requirement) — so the `planId`
 * state itself stays in the root rather than living here.
 */
import { useTranslations } from 'next-intl';
import { Controller, useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { FieldError } from '../field-error';
import { type MemberFormValues, type PlanOption } from '../schema';

export function MembershipSection({
  plans,
  mode,
  onPlanIdChange,
}: {
  readonly plans: readonly PlanOption[];
  readonly mode: 'create' | 'edit';
  readonly onPlanIdChange: (planId: string) => void;
}) {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-base font-semibold">
        {t('sections.membership')}
      </legend>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="md:col-span-2">
          <Label htmlFor="plan_id">
            {tf('plan')}
            <RequiredMark />
          </Label>
          <Controller
            control={control}
            name="plan_id"
            render={({ field }) => (
              <Select
                value={field.value ?? ''}
                onValueChange={(v) => {
                  field.onChange(v);
                  // Mirror to the root so the schema rebuilds with the
                  // plan's DOB requirement (see the planId state there).
                  onPlanIdChange(v ?? '');
                }}
              >
                <SelectTrigger
                  id="plan_id"
                  aria-required="true"
                  aria-invalid={Boolean(errors.plan_id)}
                  aria-describedby={
                    errors.plan_id ? 'plan_id-error required-fields-note' : 'required-fields-note'
                  }
                  className="w-full"
                >
                  {/* base-ui Select.Value doesn't auto-resolve
                      the matching SelectItem's text — it shows the
                      raw value unless we pass a render function that
                      maps value → display. Lookup against the plans
                      array; fall back to placeholder when unset. */}
                  <TranslatedSelectValue
                    placeholder={tf('planPlaceholder')}
                    translate={(value) =>
                      plans.find((p) => p.plan_id === value)?.display_name ?? null
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.plan_id} value={p.plan_id}>
                      {p.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <FieldError id="plan_id-error" message={errors.plan_id?.message} />
        </div>
        <div>
          <Label htmlFor="plan_year">
            {tf('planYear')}
            <RequiredMark />
          </Label>
          <Input
            id="plan_year"
            type="number"
            inputMode="numeric"
            min={2020}
            max={2100}
            required
            aria-required="true"
            aria-invalid={Boolean(errors.plan_year)}
            aria-describedby={
              errors.plan_year ? 'plan_year-error required-fields-note' : 'required-fields-note'
            }
            {...register('plan_year')}
          />
          <FieldError id="plan_year-error" message={errors.plan_year?.message} />
        </div>
      </div>

      <div>
        <Label htmlFor="registration_date">{tf('registrationDate')}</Label>
        <Input
          id="registration_date"
          type="date"
          readOnly={mode === 'edit'}
          aria-describedby={
            mode === 'edit'
              ? 'registration_date-readonly'
              : 'registration_date-hint'
          }
          // Tailwind-merge only dedupes WITHIN the same variant group —
          // `bg-muted` (no modifier) and `dark:bg-input/30` from the base
          // Input class list (input.tsx) don't collide, so the dark
          // variant wins and the read-only cue disappears in dark mode.
          // Pin the dark variant explicitly.
          className={mode === 'edit' ? 'bg-muted dark:bg-muted' : undefined}
          {...register('registration_date')}
        />
        {/* Each mode gets the copy that is true for it — create honours a
          * back-dated value verbatim (it anchors the F8 renewal cycle);
          * edit discards any change, so only the read-only note applies. */}
        {mode === 'edit' ? (
          <p
            id="registration_date-readonly"
            className="mt-1 text-xs text-muted-foreground"
          >
            {tf('registrationDateReadOnly')}
          </p>
        ) : (
          <p
            id="registration_date-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            {tf('registrationDateHint')}
          </p>
        )}
      </div>
    </fieldset>
  );
}
