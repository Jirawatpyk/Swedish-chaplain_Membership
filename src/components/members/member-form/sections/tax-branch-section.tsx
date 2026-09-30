'use client';

/**
 * MemberForm — Tax branch (§86/4) section — EDIT only, admin-managed.
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4). `isHeadOffice` is lifted to the composition root (not local state
 * here) because `use-member-form-errors.ts` needs it too, to gate the
 * branch_code summary entry.
 *
 * Spec 122 US5b-2 (T574): the board's §86/4 card with AURA checkboxes (a
 * native box named by its visible text, the hint as its description) and an
 * AURA field for the branch code.
 */
import type { RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Checkbox, TextField } from '@jirawatpyk/aura-react';
import { type MemberFormValues } from '../schema';
import { FormSectionCard } from '../form-section-card';

export function TaxBranchSection({
  mode,
  isHeadOffice,
  onIsHeadOfficeChange,
  vatManuallyTouchedRef,
}: {
  /**
   * 059 / PR-A — the VAT checkbox renders in BOTH modes (it is what makes the
   * §86/4 branch line print, and with it hidden at create there was no path that
   * could set it at birth). The head-office / branch controls stay EDIT-ONLY:
   * the create payload and the repo's create `.values()` do not write them (they
   * take the DB defaults, head-office/NULL), so offering them at create would be
   * dead state — the admin would tick a branch code and it would vanish.
   */
  readonly mode: 'create' | 'edit';
  readonly isHeadOffice: boolean;
  readonly onIsHeadOfficeChange: (isHeadOffice: boolean) => void;
  /**
   * 059 / PR-A Task 3b — shared with CompanySection (lifted to the
   * member-form.tsx composition root). Flipped to `true` here the moment
   * the admin hand-toggles this checkbox, so the entity-type Select's
   * seeding suggestion stops overwriting it. See `resolve-vat-seed.ts`.
   */
  readonly vatManuallyTouchedRef: RefObject<boolean>;
}) {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    register,
    control,
    setValue,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  // 059 / PR-A — the head-office / branch question is asked ONLY of a VAT
  // registrant, because for anyone else it has no effect on any document and no
  // meaning in law:
  //   - ประกาศอธิบดีฯ ฉบับที่ 199 makes the "สำนักงานใหญ่ / สาขาที่ NNNNN" line a
  //     §86/4 particular required ONLY of a registrant buyer;
  //   - `buyerBranchEl` in the invoice template prints it only when
  //     `buyer_is_vat_registrant === true`;
  //   - `members_branch_pairing_ck` (migration 0252) already forbids a branch
  //     that is not a registrant.
  // A natural person has no head office and no branches. Asking them to confirm
  // they ARE the head office is not just noise — it implies the answer matters,
  // and the checkbox defaults to ticked, so it looks like a fact we recorded.
  // Read-only here (no write), so there is no mount-fire hazard.
  const isVatRegistered =
    useWatch({ control, name: 'is_vat_registered' }) === true;

  return (
    <FormSectionCard id="tax-branch" title={t('sections.taxBranch')} description={tf('branchHint')}>
      <div className="flex flex-col gap-4">
        {/* 059 / PR-A — the §86/4 discriminator, RECORDED not guessed. Gates
            both the "สำนักงานใหญ่ / สาขาที่ NNNNN" line (ประกาศ 199) and the
            buyer-TIN requirement (ประกาศ 196) on every tax document this
            member receives. It was previously INFERRED from
            `legal_entity_type` ("anything not 'individual'") — wrong in law
            (VAT registration follows turnover, not legal form) and, with that
            column NULL on every row, false for everyone. Defaults to the
            stored value on edit; false on create. */}
        <Controller
          control={control}
          name="is_vat_registered"
          render={({ field }) => (
            <Checkbox
              id="is_vat_registered"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              checked={field.value ?? false}
              description={tf('isVatRegisteredHint')}
              onChange={(next) => {
                vatManuallyTouchedRef.current = true;
                field.onChange(next);
                if (!next) {
                  setValue('is_head_office', true);
                  setValue('branch_code', '');
                  onIsHeadOfficeChange(true);
                }
              }}
            >
              {tf('isVatRegistered')}
            </Checkbox>
          )}
        />
        {mode === 'edit' && isVatRegistered && (
          <Controller
            control={control}
            name="is_head_office"
            render={({ field }) => (
              <Checkbox
                id="is_head_office"
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                className="ms-6"
                checked={field.value ?? false}
                onChange={(next) => {
                  field.onChange(next);
                  onIsHeadOfficeChange(next);
                }}
              >
                {tf('isHeadOffice')}
              </Checkbox>
            )}
          />
        )}
        {mode === 'edit' && isVatRegistered && !isHeadOffice && (
          <TextField
            id="branch_code"
            className="ms-6 max-w-xs"
            label={tf('branchCode')}
            required
            aria-required="true"
            inputMode="numeric"
            maxLength={5}
            placeholder="00000"
            hint={tf('branchCodeHint')}
            error={errors.branch_code?.message}
            {...register('branch_code')}
          />
        )}
      </div>
    </FormSectionCard>
  );
}
