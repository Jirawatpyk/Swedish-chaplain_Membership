'use client';

/**
 * T053 — Member creation form.
 *
 * Spec compliance:
 *   - **FR-035 tri-part required indicator**: every required field gets
 *     (a) `aria-required="true"` programmatic + `required` attribute,
 *     (b) visible red asterisk in the label,
 *     (c) a form-top note "* fields are required".
 *     All three are present — a11y test (T053a) asserts the combination.
 *   - **FR-036 autocomplete attrs**: `given-name` / `family-name` on
 *     contact first/last name, `email`, `tel` on phone, `organization`
 *     on company name, `url` on website.
 *   - **FR-037 page title**: enforced by the parent Server Component via
 *     `generateMetadata`.
 *   - **Thai Alumni DOB gate**: `date_of_birth` field visible only when
 *     the selected plan is flagged as Thai Alumni (`max_member_age` set).
 *     Deferred to a simpler heuristic for B.2.b — shown whenever the
 *     plan metadata carries a max age; US3 can refine.
 *   - **Submit path**: delegates to the `onSubmit` callback provided by
 *     the parent client wrapper, which handles API call + dialog
 *     confirmations + redirect.
 */

import { useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Loader2Icon } from 'lucide-react';
// Deep import (NOT the `@/modules/members` barrel) — phone.ts is pure TS
// (pulls only `@/lib/result`) so it is safe in this client component and
// keeps the E.164 rule single-sourced with the domain value object.
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

// --- Form shape --------------------------------------------------------------

// A2 — schema is built per-render via this factory so zod validation messages
// resolve through the active-locale translator (TH/SV previously saw hardcoded
// English). `tf` is the `admin.members.create.fields` translator, widened to
// (key) => string at the call site (next-intl's namespaced key typing doesn't
// structurally match a plain string param). Mirrors the in-component schema
// pattern in contact-form-dialog.tsx.
function buildMemberFormSchema(tf: (key: string) => string) {
  return z.object({
  company_name: z.string().trim().min(1, tf('errors.required')).max(200),
  legal_entity_type: z.string().max(100).optional(),
  country: z
    .string()
    .length(2, tf('errors.countryCode'))
    .regex(/^[A-Za-z]{2}$/, tf('errors.countryCode')),
  tax_id: z.string().max(50).optional(),
  website: z.string().max(200).url(tf('errors.url')).optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
  address_line1: z.string().max(200).optional(),
  address_line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  founded_year: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v))),
  turnover_thb: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v))),
  plan_id: z.string().min(1, tf('errors.required')),
  plan_year: z.coerce
    .number({ invalid_type_error: tf('errors.planYear') })
    .int(tf('errors.planYear'))
    .min(2020, tf('errors.planYear'))
    .max(2100, tf('errors.planYear')),
  registration_date: z.string().optional(),
  // Round-3 N-I4 + round-4 R4-I3: accept `null` / `undefined` / `''` on
  // input and emit `null` on output. The edit form seeds defaults from
  // the DB row (nullable), but react-hook-form's defaultValues bypass
  // the .transform() — so the INPUT type must tolerate `null` to avoid a
  // zod type mismatch on imperative `trigger('notes')`.
  notes: z
    .string()
    .max(4000)
    .nullable()
    .optional()
    .transform((v) =>
      v === '' || v === undefined || v === null ? null : v,
    ),
  primary_contact: z.object({
    first_name: z.string().trim().min(1, tf('errors.required')).max(100),
    last_name: z.string().trim().min(1, tf('errors.required')).max(100),
    email: z.string().trim().min(1, tf('errors.required')).max(254),
    // Phone must be E.164 (matches the `asPhone` domain value object used
    // by create-member + updateContactFields). Validating client-side
    // highlights the field inline instead of letting the server reject it
    // with a 400 that surfaces only as a generic "fix highlighted fields"
    // toast with nothing actually highlighted. Empty is allowed (optional);
    // spaces / dashes / parens are stripped before the format check so
    // "+66 81-234-5678" is accepted and normalised server-side.
    phone: z
      .string()
      .max(20)
      .optional()
      .refine((v) => v === undefined || isAcceptablePhoneInput(v), {
        message: tf('phoneError'),
      }),
    role_title: z.string().max(100).optional(),
    preferred_language: z.enum(['en', 'th', 'sv']),
    date_of_birth: z.string().optional(),
  }),
  });
}

export type MemberFormValues = z.infer<
  ReturnType<typeof buildMemberFormSchema>
>;


// --- Props -------------------------------------------------------------------

export type PlanOption = {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly display_name: string;
  /** When set, the plan requires DOB on the primary contact (Thai Alumni etc.). */
  readonly requires_date_of_birth?: boolean;
};

type Props = {
  readonly plans: readonly PlanOption[];
  readonly defaultPlanYear: number;
  readonly onSubmit: (values: MemberFormValues) => Promise<void> | void;
  readonly submitting: boolean;
  readonly onCancel?: () => void;
  /** When set, pre-fills the form from these values (edit mode). */
  readonly initialValues?: Partial<MemberFormValues>;
  /** 'create' (default) or 'edit' — switches submit/submitting labels. */
  readonly mode?: 'create' | 'edit';
};

// --- Small visual helpers ----------------------------------------------------

function RequiredMark() {
  return (
    <span aria-hidden className="ml-0.5 text-destructive">
      *
    </span>
  );
}

/**
 * B3: FieldError now requires an `id` so each input can reference it via
 * `aria-describedby`. Pattern matches portal-edit-form.tsx exactly.
 */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}

// --- Component ---------------------------------------------------------------

export function MemberForm({
  plans,
  defaultPlanYear,
  onSubmit,
  submitting,
  onCancel,
  initialValues,
  mode = 'create',
}: Props) {
  // Shared copy (section headers, required note, field labels) lives
  // under `admin.members.create.*` since it's identical for create +
  // edit. Only the submit button + submitting label differ per mode —
  // those resolve via `submitLabel` / `submittingLabel` below.
  const t = useTranslations('admin.members.create');
  const tEdit = useTranslations('admin.members.edit');
  const tf = useTranslations('admin.members.create.fields');
  const tLang = useTranslations('common');
  const submitLabel = mode === 'edit' ? tEdit('submit') : t('submit');
  const submittingLabel =
    mode === 'edit' ? tEdit('submitting') : t('submitting');
  const cancelLabel = mode === 'edit' ? tEdit('cancel') : t('cancel');

  // Build the zod schema with the active-locale field-error translator. `tf`
  // is stable per locale render (next-intl), so the memo only re-runs on a
  // locale switch (which re-renders the page anyway).
  const schema = useMemo(
    () => buildMemberFormSchema(tf as (key: string) => string),
    [tf],
  );

  const {
    register,
    handleSubmit,
    watch,
    control,
    formState: { errors },
  } = useForm<MemberFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      country: initialValues?.country ?? 'TH',
      plan_year: initialValues?.plan_year ?? defaultPlanYear,
      ...(initialValues ?? {}),
      primary_contact: {
        preferred_language: 'en',
        ...(initialValues?.primary_contact ?? {}),
      },
    } as MemberFormValues,
  });

  // react-hook-form's `watch()` returns a fresh subscription each render,
  // which the React compiler flags as incompatible-library. This is safe
  // here — the form is a leaf component and compile-level memoization
  // isn't on the critical path. See same pattern in F2 plan-form-wizard.
  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedPlanId = watch('plan_id');
  const selectedPlan = plans.find(
    (p) => p.plan_id === selectedPlanId,
  );
  const needsDob = Boolean(selectedPlan?.requires_date_of_birth);

  const [country, setCountry] = useState<string>(
    initialValues?.country ?? 'TH',
  );
  const countryIsTH = country.toUpperCase() === 'TH';

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-[var(--page-section-gap)]">
      {/* FR-035 part (c): form-top required fields note */}
      <p className="text-sm text-muted-foreground" id="required-fields-note">
        {t('requiredNote')}
      </p>

      {/* --- Company section --- */}
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
            />
          </div>
          <div>
            <Label htmlFor="country">
              {tf('country')}
              <RequiredMark />
            </Label>
            <Input
              id="country"
              {...register('country', {
                onChange: (e) => setCountry(e.target.value),
              })}
              required
              aria-required="true"
              aria-invalid={Boolean(errors.country)}
              aria-describedby={
                errors.country ? 'country-error required-fields-note' : 'required-fields-note'
              }
              maxLength={2}
              autoComplete="country"
              placeholder={tf('countryPlaceholder')}
              className="uppercase"
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
              aria-describedby={errors.tax_id ? 'tax_id-error' : undefined}
            />
            {countryIsTH && (
              <p className="mt-1 text-xs text-muted-foreground">
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
              {...register('founded_year')}
            />
          </div>
          <div>
            <Label htmlFor="turnover_thb">{tf('turnoverThb')}</Label>
            <Input
              id="turnover_thb"
              type="number"
              inputMode="numeric"
              min={0}
              {...register('turnover_thb')}
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
          />
        </div>

        <div>
          <Label htmlFor="notes">{tf('notes')}</Label>
          <Textarea
            id="notes"
            {...register('notes')}
            rows={3}
            maxLength={4000}
            placeholder={tf('notesPlaceholder')}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {tf('notesHint')}
          </p>
        </div>

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
                  onValueChange={field.onChange}
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
            {...register('registration_date')}
          />
        </div>
      </fieldset>

      {/* --- Address section (optional, structured) --- */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-base font-semibold">
          {t('sections.address')}
        </legend>
        <div>
          <Label htmlFor="address_line1">{tf('addressLine1')}</Label>
          <Input
            id="address_line1"
            {...register('address_line1')}
            maxLength={200}
            autoComplete="address-line1"
          />
        </div>
        <div>
          <Label htmlFor="address_line2">{tf('addressLine2')}</Label>
          <Input
            id="address_line2"
            {...register('address_line2')}
            maxLength={200}
            autoComplete="address-line2"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="city">{tf('city')}</Label>
            <Input
              id="city"
              {...register('city')}
              maxLength={100}
              autoComplete="address-level2"
            />
          </div>
          <div>
            <Label htmlFor="province">{tf('province')}</Label>
            <Input
              id="province"
              {...register('province')}
              maxLength={100}
              autoComplete="address-level1"
            />
          </div>
          <div>
            <Label htmlFor="postal_code">{tf('postalCode')}</Label>
            <Input
              id="postal_code"
              {...register('postal_code')}
              maxLength={20}
              autoComplete="postal-code"
            />
          </div>
        </div>
      </fieldset>

      {/* --- Primary contact section --- */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-base font-semibold">
          {t('sections.primaryContact')}
        </legend>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="first_name">
              {tf('firstName')}
              <RequiredMark />
            </Label>
            <Input
              id="first_name"
              {...register('primary_contact.first_name')}
              required
              aria-required="true"
              aria-invalid={Boolean(errors.primary_contact?.first_name)}
              aria-describedby={
                errors.primary_contact?.first_name
                  ? 'first_name-error required-fields-note'
                  : 'required-fields-note'
              }
              autoComplete="given-name"
              maxLength={100}
            />
            <FieldError
              id="first_name-error"
              message={errors.primary_contact?.first_name?.message}
            />
          </div>
          <div>
            <Label htmlFor="last_name">
              {tf('lastName')}
              <RequiredMark />
            </Label>
            <Input
              id="last_name"
              {...register('primary_contact.last_name')}
              required
              aria-required="true"
              aria-invalid={Boolean(errors.primary_contact?.last_name)}
              aria-describedby={
                errors.primary_contact?.last_name
                  ? 'last_name-error required-fields-note'
                  : 'required-fields-note'
              }
              autoComplete="family-name"
              maxLength={100}
            />
            <FieldError
              id="last_name-error"
              message={errors.primary_contact?.last_name?.message}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="contact_email">
              {tf('email')}
              <RequiredMark />
            </Label>
            <Input
              id="contact_email"
              type="email"
              {...register('primary_contact.email')}
              required
              aria-required="true"
              aria-invalid={Boolean(errors.primary_contact?.email)}
              aria-describedby={
                errors.primary_contact?.email
                  ? 'contact_email-error required-fields-note'
                  : 'required-fields-note'
              }
              autoComplete="email"
              maxLength={254}
            />
            <FieldError
              id="contact_email-error"
              message={errors.primary_contact?.email?.message}
            />
          </div>
          <div>
            <Label htmlFor="contact_phone">{tf('phone')}</Label>
            <Input
              id="contact_phone"
              type="tel"
              {...register('primary_contact.phone')}
              autoComplete="tel"
              maxLength={20}
              placeholder="+66812345678"
              aria-invalid={Boolean(errors.primary_contact?.phone)}
              aria-describedby={
                errors.primary_contact?.phone ? 'contact_phone-error' : undefined
              }
            />
            <FieldError
              id="contact_phone-error"
              message={errors.primary_contact?.phone?.message}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <Label htmlFor="role_title">{tf('roleTitle')}</Label>
            <Input
              id="role_title"
              {...register('primary_contact.role_title')}
              maxLength={100}
              autoComplete="organization-title"
            />
          </div>
          <div>
            <Label htmlFor="preferred_language">
              {tf('preferredLanguage')}
              <RequiredMark />
            </Label>
            <Controller
              control={control}
              name="primary_contact.preferred_language"
              render={({ field }) => (
                <Select
                  value={field.value ?? 'en'}
                  onValueChange={(v) => field.onChange(v)}
                >
                  <SelectTrigger
                    id="preferred_language"
                    aria-required="true"
                    className="w-full"
                  >
                    {/* 067 #4 review-fix — no `?? LANG_LABELS.en` fallback is
                        needed here (unlike a free-text Select): the only values
                        that reach `translate` come from this field, which the
                        zod schema pins to `z.enum(['en','th','sv'])`, and
                        `common.languageOptions.{en,th,sv}` exist in all three
                        locale files (verified). So every reachable value
                        resolves — there is no MISSING_MESSAGE path to guard. */}
                    <TranslatedSelectValue
                      translate={(value) =>
                        tLang(`languageOptions.${value as 'en' | 'th' | 'sv'}`)
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{tLang('languageOptions.en')}</SelectItem>
                    <SelectItem value="th">{tLang('languageOptions.th')}</SelectItem>
                    <SelectItem value="sv">{tLang('languageOptions.sv')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </div>

        {needsDob && (
          <div>
            <Label htmlFor="date_of_birth">
              {tf('dateOfBirth')}
              <RequiredMark />
            </Label>
            <Input
              id="date_of_birth"
              type="date"
              {...register('primary_contact.date_of_birth')}
              required
              aria-required="true"
              autoComplete="bday"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {tf('dateOfBirthHint')}
            </p>
          </div>
        )}
      </fieldset>

      <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={submitting}
          >
            {cancelLabel}
          </Button>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting && (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
          )}
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
