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
 */
import { useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { ChevronDownIcon, HelpCircleIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { RequiredMark } from '@/components/ui/required-mark';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { CountryCombobox } from '@/components/members/country-combobox';
// 059 / PR-A Task 3b — deep import (NOT the `@/modules/members` barrel),
// same rationale as schema.ts: pure TS, zero framework deps, safe in this
// client component.
import {
  LEGAL_ENTITY_TYPES,
  isLegalEntityTypeCode,
} from '@/modules/members/domain/value-objects/legal-entity-type';
import { FieldError } from '../field-error';
import { type MemberFormValues } from '../schema';
import { resolveVatSeed } from '../resolve-vat-seed';

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
          {/* The gap below the label lives on THIS wrapper, and the Label is
            * reset to `mb-0`. `ui/label.tsx` ships `mb-[var(--field-label-gap)]`
            * on the Label itself — fine when the Label is the block above its
            * control (every other field here), but inside a flex row that
            * bottom margin is trapped IN the row: it inflates the row, so
            * `items-center` drops the help icon below the label text, and it
            * leaves no gap at all before the Select. Moving it out restores
            * both. */}
          <div className="mb-[var(--field-label-gap)] flex items-center gap-1">
            <Label htmlFor="legal_entity_type" className="mb-0">
              {tf('legalEntityType')}
            </Label>
            {/* 059 / PR-A Task 3b — reviewer feedback item #3 asked for an
              * explanation of each type. Tap-discoverable Popover (not a
              * hover Tooltip — must work on mobile), same pattern as the
              * Contacts section's "Emergency primary contact transfer"
              * helper (admin/members/[memberId]/page.tsx). The explicit
              * `type="button"` is defensive redundancy, not a fix for an
              * observed bug: Base UI's `PopoverTrigger` already renders a
              * native button with `type="button"` on its own (`useButton`'s
              * `getButtonProps`, applied last by `mergeProps`), so this
              * popover — which lives inside <form onSubmit> — would not
              * actually have submitted the form without this prop. Kept
              * explicit anyway: harmless, and it removes the dependency on
              * that Base UI internal for anyone reading this in isolation. */}
            <Popover>
              {/* `size-6` + `-my-2` — both load-bearing; the geometry is tight
                * and every other combination breaks something visible.
                *
                * Two constraints have to hold at once:
                *   1. The button must not GROW the label row. The Label is
                *      `leading-none`, so the row is only ~14px; any flex item
                *      whose outer height exceeds that pushes the Select down and
                *      this field falls out of line with `country` / `tax_id`
                *      beside it. `-my-2` cuts the 24px box to an 8px outer
                *      height — under the label — so the row height is decided by
                *      the Label alone, exactly as in every sibling field.
                *   2. The button must not REACH the Select. Centred in a ~14px
                *      row, a 24px box overhangs ~5px, which fits inside
                *      `--field-label-gap` (6px). At 32px it overhangs 9px and at
                *      44px, 15px — both land on the Select and swallow clicks
                *      along its top edge.
                *
                * 24px is not an arbitrary shrink: it is exactly WCAG 2.2
                * SC 2.5.8's minimum, and exactly `MIN_TARGET_PX` in
                * `tests/e2e/members-target-size-2-2.spec.ts`, which measures the
                * real box via `boundingBox()` — so the element must genuinely BE
                * 24px. A pseudo-element hit area would report the 16px icon and
                * fail that gate. */}
              <PopoverTrigger
                type="button"
                aria-label={tf('legalEntityTypeHelpAriaLabel')}
                className="-my-2 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HelpCircleIcon className="size-4" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent
                className="w-80 max-w-[calc(100vw-2rem)] text-sm"
                sideOffset={4}
              >
                <p className="font-medium">{tf('legalEntityTypeHelpTitle')}</p>
                <dl className="mt-2 max-h-80 space-y-2 overflow-y-auto pr-1">
                  {LEGAL_ENTITY_TYPES.map((code) => (
                    <div key={code}>
                      <dt className="font-medium text-foreground">
                        {tTypes(code)}
                      </dt>
                      <dd className="text-muted-foreground">{tExplain(code)}</dd>
                    </div>
                  ))}
                </dl>
              </PopoverContent>
            </Popover>
          </div>
          <Controller
            control={control}
            name="legal_entity_type"
            render={({ field }) => (
              <Select
                value={field.value ?? ''}
                onValueChange={(next) => {
                  const code = next ?? '';
                  field.onChange(code);
                  // 059 / PR-A Task 3b — seed is_vat_registered from the
                  // picked type's default. This runs INSIDE a
                  // user-initiated onValueChange (never a
                  // useEffect/useWatch) — the PR-B Critical this class of
                  // bug produced was an effect firing on MOUNT because
                  // useWatch returns defaultValues on the first render; a
                  // Select's onValueChange literally cannot fire without
                  // the admin picking an option, so there is no
                  // mount-firing path to guard against here in the first
                  // place. See resolve-vat-seed.ts for the three gates.
                  const seed = resolveVatSeed({
                    code,
                    vatManuallyTouched: vatManuallyTouchedRef.current,
                  });
                  if (seed !== null) {
                    setValue('is_vat_registered', seed, { shouldDirty: true });
                  }
                }}
              >
                <SelectTrigger
                  id="legal_entity_type"
                  aria-invalid={Boolean(errors.legal_entity_type)}
                  aria-describedby={
                    errors.legal_entity_type
                      ? 'legal_entity_type-error'
                      : undefined
                  }
                  className="w-full"
                >
                  <TranslatedSelectValue
                    placeholder={tf('legalEntityTypePlaceholder')}
                    translate={(value) =>
                      isLegalEntityTypeCode(value) ? tTypes(value) : null
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {LEGAL_ENTITY_TYPES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {tTypes(code)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
          <Label htmlFor="tax_id">
            {tf('taxId')}
            {isVatRegistered && <RequiredMark />}
          </Label>
          <Input
            id="tax_id"
            {...register('tax_id')}
            maxLength={50}
            aria-required={isVatRegistered}
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

      {/* PR-B task 7 — genuinely optional fields, not needed to create a
        * member: description, notes, founded_year, turnover_thb,
        * registered_capital_thb. `keepMounted` on the panel keeps every
        * field permanently in the DOM (never unmounted) — closed just sets
        * the native `hidden` attribute, which already removes it from the
        * accessibility tree and from `getByRole` queries. That is what lets
        * `additionalDetailsOpen` force back to `true` synchronously the
        * moment one of these fields errors, with no mount/ref timing gap for
        * react-hook-form's focus-on-error to race against. */}
      <Collapsible open={additionalDetailsOpen} onOpenChange={setAdditionalOpen}>
        <CollapsibleTrigger
          render={
            <Button type="button" variant="ghost" className="group w-full justify-between" />
          }
        >
          {t('sections.additionalDetails')}
          <ChevronDownIcon
            className="size-4 shrink-0 transition-transform duration-200 group-data-[panel-open]:rotate-180"
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="flex flex-col gap-4 pt-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
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
                aria-describedby={
                  [
                    errors.turnover_thb ? 'turnover_thb-error' : null,
                    'turnover_thb-hint',
                  ]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                {...register('turnover_thb')}
              />
              {/* Reviewer asked to RENAME this to registered capital — deliberately
                * not done: turnover gates the F2 plan turnover band (out-of-band ⇒
                * mandatory override reason) and drives F8 auto tier-upgrade
                * suggestions. Renaming the label would silently re-point a
                * membership-tier business rule at a different quantity. */}
              <p id="turnover_thb-hint" className="mt-1 text-xs text-muted-foreground">
                {tf('turnoverHint')}
              </p>
              <FieldError id="turnover_thb-error" message={errors.turnover_thb?.message} />
            </div>
            <div>
              <Label htmlFor="registered_capital_thb">{tf('registeredCapitalThb')}</Label>
              <Input
                id="registered_capital_thb"
                type="number"
                inputMode="numeric"
                min={0}
                aria-invalid={Boolean(errors.registered_capital_thb)}
                aria-describedby={
                  errors.registered_capital_thb ? 'registered_capital_thb-error' : undefined
                }
                {...register('registered_capital_thb')}
              />
              <FieldError
                id="registered_capital_thb-error"
                message={errors.registered_capital_thb?.message}
              />
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
        </CollapsibleContent>
      </Collapsible>
    </fieldset>
  );
}
