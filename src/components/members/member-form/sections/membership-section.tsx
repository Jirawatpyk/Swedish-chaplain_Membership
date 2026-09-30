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
 *
 * Spec 122 US5b-2 (T575): the board's Membership card, two fields a row from
 * 640px. AURA `Select` lists one line per option, so the plan's annual fee
 * is the field hint for the selected plan (maintainer, 30 Sep). The
 * registration date is an AURA `DatePicker` on create (typed or picked;
 * Buddhist-era years shown in Thai, the value stays ISO) and read-only text
 * on edit, as the board draws it.
 */
import { useTranslations, useLocale } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { DatePicker, Select, TextField, type ISODate } from '@jirawatpyk/aura-react';
import { formatSatangThb } from '@/lib/format-thb';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { type MemberFormValues, type PlanOption } from '../schema';
import { FormSectionCard } from '../form-section-card';

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
  // Locale for the canonical `formatSatangThb` money formatter — the SAME
  // suffix-style "36,000.00 THB" the plan-change confirm dialog renders
  // (`plan-change-summary.ts` → `format-thb.ts`), so the picker and the confirm
  // dialog read identically within the member-edit flow (enterprise-ux C1).
  // `formatSatangThb` is pure/client-safe; the plans-domain `formatMoney` lives
  // behind the server-heavy `@/modules/plans` barrel and can't be imported here.
  const locale = useLocale();
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  function planFeeLabel(p: PlanOption): string | null {
    if (
      p.annual_fee_minor_units === undefined ||
      p.currency_code === undefined ||
      !Number.isInteger(p.annual_fee_minor_units)
    ) {
      return null;
    }
    return formatSatangThb(
      BigInt(p.annual_fee_minor_units),
      locale,
      p.currency_code,
    );
  }

  const selectedPlanId = useWatch({ control, name: 'plan_id' });
  const selectedPlan = plans.find((p) => p.plan_id === selectedPlanId);
  const selectedFee = selectedPlan ? planFeeLabel(selectedPlan) : null;
  const registrationDate = useWatch({ control, name: 'registration_date' });

  return (
    <FormSectionCard id="membership" title={t('sections.membership')}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="plan_id"
          render={({ field }) => (
            <Select
              id="plan_id"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              label={tf('plan')}
              required
              value={field.value ?? ''}
              placeholder={tf('planPlaceholder')}
              options={plans.map((p) => ({ value: p.plan_id, label: p.display_name }))}
              hint={selectedFee !== null ? `${tf('planAnnualFee')}: ${selectedFee}` : undefined}
              error={errors.plan_id?.message}
              onChange={(e) => {
                field.onChange(e.target.value);
                // Mirror to the root so the schema rebuilds with the plan's
                // DOB requirement (see the planId state there).
                onPlanIdChange(e.target.value);
              }}
            />
          )}
        />
        <TextField
          id="plan_year"
          type="number"
          inputMode="numeric"
          label={tf('planYear')}
          min={2020}
          max={2100}
          required
          aria-required="true"
          aria-describedby="required-fields-note"
          error={errors.plan_year?.message}
          {...register('plan_year')}
        />

        {/* 065 §5.1 — per-member billing cadence. A REQUIRED free choice
            (calendar year vs rolling anniversary). */}
        <Controller
          control={control}
          name="billing_cycle"
          render={({ field }) => (
            <Select
              id="billing_cycle"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              label={tf('billingCycle')}
              required
              value={field.value ?? ''}
              placeholder={tf('billingCyclePlaceholder')}
              options={[
                { value: 'calendar', label: tf('billingCycleOptions.calendar') },
                { value: 'rolling', label: tf('billingCycleOptions.rolling') },
              ]}
              error={errors.billing_cycle?.message}
              onChange={(e) => field.onChange(e.target.value)}
            />
          )}
        />

        {/* Each mode gets the copy that is true for it — create honours a
          * back-dated value verbatim (it anchors the F8 renewal cycle);
          * edit discards any change, so the field is read-only text with
          * only the read-only note. The stored value stays in the form's
          * defaults either way. */}
        {mode === 'edit' ? (
          <TextField
            id="registration_date"
            label={tf('registrationDate')}
            readOnly
            value={registrationDate ? formatLocalisedDate(registrationDate, locale) : ''}
            hint={tf('registrationDateReadOnly')}
          />
        ) : (
          <Controller
            control={control}
            name="registration_date"
            render={({ field }) => (
              <DatePicker
                id="registration_date"
                name={field.name}
                // The input carries RHF's ref so a failed submit can focus it.
                ref={field.ref}
                label={tf('registrationDate')}
                timeZone="Asia/Bangkok"
                value={(field.value || null) as ISODate | null}
                onChange={(iso) => field.onChange(iso ?? '')}
                hint={tf('registrationDateHint')}
                error={errors.registration_date?.message}
              />
            )}
          />
        )}
      </div>
    </FormSectionCard>
  );
}
