'use client';

/**
 * MemberForm — Company section (company name, legal entity type, country,
 * tax ID, website, founded year, turnover, description, admin notes).
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4) — reads/writes form state via `useFormContext` instead of
 * prop-drilled `register`/`errors`.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import { CountryCombobox } from '@/components/members/country-combobox';
import { FieldError } from '../field-error';
import { type MemberFormValues } from '../schema';

export function CompanySection({ mode }: { readonly mode: 'create' | 'edit' }) {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    register,
    control,
    getValues,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  // Drives the TH tax-id hint below the Tax ID field — local to this section
  // since nothing outside Company reads it. Seeded from RHF's own
  // defaultValue (set by the composition root from `initialValues?.country
  // ?? 'TH'`) rather than prop-drilling `initialValues` into the section.
  const [country, setCountry] = useState<string>(
    () => getValues('country') ?? 'TH',
  );
  const countryIsTH = country.toUpperCase() === 'TH';

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-base font-semibold">
        {t('sections.company')}
      </legend>

      <div>
        <Label htmlFor="company_name">
          {tf('companyName')}
          <RequiredMark />
        </Label>
        <Input
          id="company_name"
          // Auto-focus the primary input on create (ux-standards § 7.2);
          // never on edit, so opening an edit form doesn't steal scroll/focus.
          autoFocus={mode === 'create'}
          {...register('company_name')}
          required
          aria-required="true"
          aria-invalid={Boolean(errors.company_name)}
          aria-describedby={
            errors.company_name
              ? 'company_name-error required-fields-note'
              : 'required-fields-note'
          }
          autoComplete="organization"
          maxLength={200}
        />
        <FieldError id="company_name-error" message={errors.company_name?.message} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="legal_entity_type">{tf('legalEntityType')}</Label>
          <Input
            id="legal_entity_type"
            {...register('legal_entity_type')}
            maxLength={100}
            aria-invalid={Boolean(errors.legal_entity_type)}
            aria-describedby={
              errors.legal_entity_type ? 'legal_entity_type-error' : undefined
            }
          />
          <FieldError
            id="legal_entity_type-error"
            message={errors.legal_entity_type?.message}
          />
        </div>
        <div>
          <Label id="country-label" htmlFor="country">
            {tf('country')}
            <RequiredMark />
          </Label>
          <Controller
            control={control}
            name="country"
            render={({ field }) => (
              <CountryCombobox
                id="country"
                value={field.value ?? 'TH'}
                onChange={(next) => {
                  field.onChange(next);
                  setCountry(next);
                }}
                aria-labelledby="country-label"
                aria-required
                aria-invalid={Boolean(errors.country)}
                aria-describedby={
                  errors.country
                    ? 'country-error required-fields-note'
                    : 'required-fields-note'
                }
              />
            )}
          />
          <FieldError id="country-error" message={errors.country?.message} />
        </div>
        <div>
          <Label htmlFor="tax_id">{tf('taxId')}</Label>
          <Input
            id="tax_id"
            {...register('tax_id')}
            maxLength={50}
            aria-invalid={Boolean(errors.tax_id)}
            aria-describedby={
              [
                errors.tax_id ? 'tax_id-error' : null,
                countryIsTH ? 'tax_id-hint' : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          {countryIsTH && (
            <p id="tax_id-hint" className="mt-1 text-xs text-muted-foreground">
              {tf('taxIdHintTH')}
            </p>
          )}
          <FieldError id="tax_id-error" message={errors.tax_id?.message} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <Label htmlFor="website">{tf('website')}</Label>
          <Input
            id="website"
            type="url"
            {...register('website')}
            autoComplete="url"
            maxLength={200}
            placeholder={tf('websitePlaceholder')}
            aria-invalid={Boolean(errors.website)}
            aria-describedby={errors.website ? 'website-error' : undefined}
          />
          <FieldError id="website-error" message={errors.website?.message} />
        </div>
        <div>
          <Label htmlFor="founded_year">{tf('foundedYear')}</Label>
          <Input
            id="founded_year"
            type="number"
            inputMode="numeric"
            min={1800}
            max={new Date().getUTCFullYear()}
            aria-invalid={Boolean(errors.founded_year)}
            aria-describedby={errors.founded_year ? 'founded_year-error' : undefined}
            {...register('founded_year')}
          />
          <FieldError id="founded_year-error" message={errors.founded_year?.message} />
        </div>
        <div>
          <Label htmlFor="turnover_thb">{tf('turnoverThb')}</Label>
          <Input
            id="turnover_thb"
            type="number"
            inputMode="numeric"
            min={0}
            aria-invalid={Boolean(errors.turnover_thb)}
            aria-describedby={errors.turnover_thb ? 'turnover_thb-error' : undefined}
            {...register('turnover_thb')}
          />
          <FieldError id="turnover_thb-error" message={errors.turnover_thb?.message} />
        </div>
      </div>

      <div>
        <Label htmlFor="description">{tf('description')}</Label>
        <Textarea
          id="description"
          {...register('description')}
          rows={3}
          maxLength={2000}
          aria-invalid={Boolean(errors.description)}
          aria-describedby={
            errors.description ? 'description-error' : undefined
          }
        />
        <FieldError id="description-error" message={errors.description?.message} />
      </div>

      <div>
        <Label htmlFor="notes">{tf('notes')}</Label>
        <Textarea
          id="notes"
          {...register('notes')}
          rows={3}
          maxLength={4000}
          placeholder={tf('notesPlaceholder')}
          aria-invalid={Boolean(errors.notes)}
          aria-describedby={
            errors.notes ? 'notes-error notes-hint' : 'notes-hint'
          }
        />
        <p id="notes-hint" className="mt-1 text-xs text-muted-foreground">
          {tf('notesHint')}
        </p>
        <FieldError id="notes-error" message={errors.notes?.message} />
      </div>
    </fieldset>
  );
}
