'use client';

/**
 * MemberForm — Company section (company name, legal entity type, country,
 * tax ID, website). The genuinely-optional fields (founded year, turnover,
 * registered capital, description, admin notes) live behind an "Additional
 * details" collapsible (PR-B task 7).
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4) — reads/writes form state via `useFormContext` instead of
 * prop-drilled `register`/`errors`.
 *
 * Spec 122 US5b-2 (T574): AURA fields in the board's Company card — the name
 * across, then two a row from 640px — the entity-type help in an AURA
 * Popover and "Additional details" in an AURA Accordion (its panel stays
 * mounted and `hidden` while closed, as `keepMounted` did).
 */
import { useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { HelpCircleIcon } from 'lucide-react';
import { Accordion, IconButton, Popover, Select, TextField, Textarea } from '@jirawatpyk/aura-react';
import { CountryCombobox } from '@/components/members/country-combobox';
// 059 / PR-A Task 3b — deep import (NOT the `@/modules/members` barrel),
// same rationale as schema.ts: pure TS, zero framework deps, safe in this
// client component.
import { LEGAL_ENTITY_TYPES } from '@/modules/members/domain/value-objects/legal-entity-type';
import { type MemberFormValues } from '../schema';
import { resolveVatSeed } from '../resolve-vat-seed';
import { FormSectionCard } from '../form-section-card';

export function CompanySection({
  mode,
  vatManuallyTouchedRef,
}: {
  readonly mode: 'create' | 'edit';
  /**
   * 059 / PR-A Task 3b — shared with TaxBranchSection (lifted to the
   * member-form.tsx composition root, both sections are siblings under the
   * same FormProvider). Read here (never written) to decide whether picking
   * a new entity type should still seed `is_vat_registered`.
   */
  readonly vatManuallyTouchedRef: RefObject<boolean>;
}) {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  // 059 / PR-A Task 3b — the SAME 12 labels the admin member-detail page
  // resolves `legal_entity_type` through (reused, not duplicated).
  const tTypes = useTranslations('admin.members.detail.legalEntityTypes');
  const tExplain = useTranslations(
    'admin.members.create.fields.legalEntityTypeExplanations',
  );
  const {
    register,
    control,
    getValues,
    setValue,
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

  // 060 / Task 9 — the Tax ID field is required ONLY for a VAT registrant (the
  // zod rule in schema.ts enforces registrant ⇒ tax_id). `is_vat_registered`
  // lives in the sibling TaxBranchSection, but both share one FormProvider, so
  // this read-only watch sees it. Read-only → no mount-fire hazard.
  const isVatRegistered =
    useWatch({ control, name: 'is_vat_registered' }) === true;

  // PR-B task 7 — "Additional details" collapsible (description, notes,
  // founded_year, turnover_thb, registered_capital_thb). Closed by default
  // (none of these are needed to create a member), but FORCE-derived open
  // whenever one of its own fields has a validation error: a collapsed panel
  // hides the error and FormErrorSummary's jump link would land inside a
  // closed section (invisible, unfocusable). This is a pure per-render
  // derivation, not a setState-in-effect — no timing gap between the errors
  // updating and the panel unhiding in the same commit. While an error is
  // present the panel also cannot be manually re-collapsed (clicking the
  // trigger only updates `additionalOpen`; `hasAdditionalError` still wins
  // the `||`) — deliberate: never let an admin hide an unresolved error.
  const [additionalOpen, setAdditionalOpen] = useState(false);
  const hasAdditionalError = Boolean(
    errors.description ||
      errors.notes ||
      errors.founded_year ||
      errors.turnover_thb ||
      errors.registered_capital_thb,
  );
  const additionalDetailsOpen = additionalOpen || hasAdditionalError;

  return (
    <FormSectionCard id="company" title={t('sections.company')}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField
          id="company_name"
          className="sm:col-span-2"
          label={tf('companyName')}
          required
          aria-required="true"
          // Auto-focus the primary input on create (ux-standards § 7.2);
          // never on edit, so opening an edit form doesn't steal scroll/focus.
          autoFocus={mode === 'create'}
          autoComplete="organization"
          maxLength={200}
          error={errors.company_name?.message}
          aria-describedby="required-fields-note"
          {...register('company_name')}
        />

        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-1">
            <label htmlFor="legal_entity_type" className="aura-text-label text-[var(--aura-fg-primary)]">
              {tf('legalEntityType')}
            </label>
            {/* 059 / PR-A Task 3b — reviewer feedback item #3 asked for an
              * explanation of each type. Tap-discoverable (not a hover
              * tooltip — must work on mobile). The 32px icon button is pulled
              * into the label row with negative margins so it neither grows
              * the row (the field stays level with Country beside it) nor
              * shrinks its target below WCAG 2.5.8's 24px. */}
            <Popover
              title={tf('legalEntityTypeHelpTitle')}
              width={320}
              placement="bottom-start"
              trigger={
                <IconButton
                  type="button"
                  icon={<HelpCircleIcon className="size-4" aria-hidden="true" />}
                  label={tf('legalEntityTypeHelpAriaLabel')}
                  className="-my-2"
                />
              }
            >
              <dl className="max-h-80 space-y-2 overflow-y-auto pe-1 text-sm">
                {LEGAL_ENTITY_TYPES.map((code) => (
                  <div key={code}>
                    <dt className="font-medium text-[var(--aura-fg-primary)]">{tTypes(code)}</dt>
                    <dd className="text-[var(--aura-fg-secondary)]">{tExplain(code)}</dd>
                  </div>
                ))}
              </dl>
            </Popover>
          </div>
          <Controller
            control={control}
            name="legal_entity_type"
            render={({ field }) => (
              <Select
                id="legal_entity_type"
                name={field.name}
                ref={field.ref}
                onBlur={field.onBlur}
                value={field.value ?? ''}
                placeholder={tf('legalEntityTypePlaceholder')}
                options={LEGAL_ENTITY_TYPES.map((code) => ({ value: code, label: tTypes(code) }))}
                error={errors.legal_entity_type?.message}
                onChange={(e) => {
                  const code = e.target.value;
                  field.onChange(code);
                  // 059 / PR-A Task 3b — seed is_vat_registered from the
                  // picked type's default. This runs INSIDE a user-initiated
                  // change (never a useEffect/useWatch) — the PR-B Critical
                  // this class of bug produced was an effect firing on MOUNT
                  // because useWatch returns defaultValues on the first
                  // render; a change event cannot fire without the admin
                  // picking an option. See resolve-vat-seed.ts for the gates.
                  const seed = resolveVatSeed({
                    code,
                    vatManuallyTouched: vatManuallyTouchedRef.current,
                  });
                  if (seed !== null) {
                    setValue('is_vat_registered', seed, { shouldDirty: true });
                  }
                }}
              />
            )}
          />
        </div>

        <Controller
          control={control}
          name="country"
          render={({ field }) => (
            <CountryCombobox
              ref={field.ref}
              id="country"
              label={tf('country')}
              required
              value={field.value ?? 'TH'}
              error={errors.country?.message}
              onChange={(next) => {
                field.onChange(next);
                setCountry(next);
              }}
            />
          )}
        />

        <TextField
          id="tax_id"
          label={tf('taxId')}
          required={isVatRegistered}
          aria-required={isVatRegistered}
          maxLength={50}
          hint={countryIsTH ? tf('taxIdHintTH') : undefined}
          error={errors.tax_id?.message}
          {...register('tax_id')}
        />

        <TextField
          id="website"
          type="url"
          label={tf('website')}
          autoComplete="url"
          maxLength={200}
          placeholder={tf('websitePlaceholder')}
          error={errors.website?.message}
          {...register('website')}
        />
      </div>

      {/* PR-B task 7 — genuinely optional fields, not needed to create a
        * member: description, notes, founded_year, turnover_thb,
        * registered_capital_thb. The Accordion keeps its panel mounted and
        * sets the native `hidden` attribute while closed, which removes the
        * fields from the accessibility tree and from `getByRole` queries.
        * That is what lets `additionalDetailsOpen` force back to open
        * synchronously the moment one of these fields errors, with no
        * mount/ref timing gap for react-hook-form's focus-on-error. */}
      <Accordion
        className="mt-4"
        headingLevel={3}
        value={additionalDetailsOpen ? 'additional' : null}
        onChange={(next: string | null) => setAdditionalOpen(next === 'additional')}
        items={[
          {
            id: 'additional',
            title: t('sections.additionalDetails'),
            content: (
              <div className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <TextField
                    id="founded_year"
                    type="number"
                    inputMode="numeric"
                    label={tf('foundedYear')}
                    min={1800}
                    max={new Date().getUTCFullYear()}
                    error={errors.founded_year?.message}
                    {...register('founded_year')}
                  />
                  {/* Reviewer asked to RENAME this to registered capital —
                    * deliberately not done: turnover gates the F2 plan
                    * turnover band (out-of-band ⇒ mandatory override reason)
                    * and drives F8 auto tier-upgrade suggestions. Renaming the
                    * label would silently re-point a membership-tier business
                    * rule at a different quantity. */}
                  <TextField
                    id="turnover_thb"
                    type="number"
                    inputMode="numeric"
                    label={tf('turnoverThb')}
                    min={0}
                    hint={tf('turnoverHint')}
                    error={errors.turnover_thb?.message}
                    {...register('turnover_thb')}
                  />
                  <TextField
                    id="registered_capital_thb"
                    type="number"
                    inputMode="numeric"
                    label={tf('registeredCapitalThb')}
                    min={0}
                    error={errors.registered_capital_thb?.message}
                    {...register('registered_capital_thb')}
                  />
                </div>
                <Textarea
                  id="description"
                  label={tf('description')}
                  rows={3}
                  maxLength={2000}
                  error={errors.description?.message}
                  {...register('description')}
                />
                <Textarea
                  id="notes"
                  label={tf('notes')}
                  rows={3}
                  maxLength={4000}
                  placeholder={tf('notesPlaceholder')}
                  hint={tf('notesHint')}
                  error={errors.notes?.message}
                  {...register('notes')}
                />
              </div>
            ),
          },
        ]}
      />
    </FormSectionCard>
  );
}
