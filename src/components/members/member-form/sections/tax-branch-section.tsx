'use client';

/**
 * MemberForm — Tax branch (§86/4) section — EDIT only, admin-managed.
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4). `isHeadOffice` is lifted to the composition root (not local state
 * here) because `use-member-form-errors.ts` needs it too, to gate the
 * branch_code summary entry.
 *
 * Also folds in one of the two PR-B task-4 cleanups: the raw
 * `<input type="checkbox">` predates `@/components/ui/checkbox.tsx` (Base
 * UI, with focus ring + aria-invalid + indeterminate) — swapped in here.
 */
import { useTranslations } from 'next-intl';
import { Controller, useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldError } from '../field-error';
import { type MemberFormValues } from '../schema';

export function TaxBranchSection({
  isHeadOffice,
  onIsHeadOfficeChange,
}: {
  readonly isHeadOffice: boolean;
  readonly onIsHeadOfficeChange: (isHeadOffice: boolean) => void;
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
        {t('sections.taxBranch')}
      </legend>
      <p className="text-xs text-muted-foreground">{tf('branchHint')}</p>
      {/* 059 / PR-A — the §86/4 discriminator, RECORDED not guessed. Gates both
          the "สำนักงานใหญ่ / สาขาที่ NNNNN" line (ประกาศ 199) and the buyer-TIN
          requirement (ประกาศ 196) on every tax document this member receives.
          It was previously INFERRED from `legal_entity_type` ("anything not
          'individual'") — wrong in law (VAT registration follows turnover, not
          legal form) and, with that column NULL on every row, false for
          everyone. Defaults to the stored value on edit; false on create. */}
      <div className="flex items-start gap-2">
        <Controller
          control={control}
          name="is_vat_registered"
          render={({ field }) => (
            <Checkbox
              id="is_vat_registered"
              className="mt-0.5"
              // See the is_head_office note below — base-ui Checkbox.Root needs
              // the accessible name set directly.
              aria-label={tf('isVatRegistered')}
              checked={field.value ?? false}
              onCheckedChange={(checked) => field.onChange(checked === true)}
            />
          )}
        />
        <div>
          <Label htmlFor="is_vat_registered" className="font-normal">
            {tf('isVatRegistered')}
          </Label>
          <p className="mt-1 text-xs text-muted-foreground">
            {tf('isVatRegisteredHint')}
          </p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Controller
          control={control}
          name="is_head_office"
          render={({ field }) => (
            <Checkbox
              id="is_head_office"
              className="mt-0.5"
              // base-ui Checkbox.Root's visible `role=checkbox` element uses
              // its own generated id (the `id` prop we pass lands on the
              // hidden native input instead), so the sibling <Label
              // htmlFor> can't reliably name it — set the accessible name
              // directly (same fix as schedule-picker.tsx's
              // `#schedule-immediate`, "fixes axe aria-toggle-field-name").
              aria-label={tf('isHeadOffice')}
              checked={field.value ?? false}
              onCheckedChange={(checked) => {
                const next = checked === true;
                field.onChange(next);
                onIsHeadOfficeChange(next);
              }}
            />
          )}
        />
        <Label htmlFor="is_head_office" className="font-normal">
          {tf('isHeadOffice')}
        </Label>
      </div>
      {!isHeadOffice && (
        <div className="max-w-xs">
          <Label htmlFor="branch_code">
            {tf('branchCode')}
            <RequiredMark />
          </Label>
          <Input
            id="branch_code"
            inputMode="numeric"
            maxLength={5}
            placeholder="00000"
            {...register('branch_code')}
            aria-required="true"
            aria-invalid={Boolean(errors.branch_code)}
            aria-describedby={
              errors.branch_code
                ? 'branch_code-error branch_code-hint'
                : 'branch_code-hint'
            }
          />
          <p
            id="branch_code-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            {tf('branchCodeHint')}
          </p>
          <FieldError
            id="branch_code-error"
            message={errors.branch_code?.message}
          />
        </div>
      )}
    </fieldset>
  );
}
