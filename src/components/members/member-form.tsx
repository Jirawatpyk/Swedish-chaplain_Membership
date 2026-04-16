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

import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// --- Form shape --------------------------------------------------------------

export const memberFormSchema = z.object({
  company_name: z.string().trim().min(1, 'required').max(200),
  legal_entity_type: z.string().max(100).optional(),
  country: z
    .string()
    .length(2, 'Use ISO 3166-1 alpha-2 code, e.g. TH, SE, US')
    .regex(/^[A-Za-z]{2}$/, 'Use ISO 3166-1 alpha-2 code'),
  tax_id: z.string().max(50).optional(),
  website: z.string().max(200).url().optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
  founded_year: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v))),
  turnover_thb: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v))),
  plan_id: z.string().min(1, 'required'),
  plan_year: z.coerce.number().int().min(2020).max(2100),
  registration_date: z.string().optional(),
  // Round-3 review N-I4: transform empty string to null so the form's
  // "clear notes" path produces null (matches inline-edit + use case schema
  // which accepts null). Prevents silent data-integrity divergence between
  // form + inline-edit write paths.
  notes: z
    .string()
    .max(4000)
    .optional()
    .transform((v) => (v === '' || v === undefined ? null : v)),
  primary_contact: z.object({
    first_name: z.string().trim().min(1, 'required').max(100),
    last_name: z.string().trim().min(1, 'required').max(100),
    email: z.string().trim().min(1, 'required').max(254),
    phone: z.string().max(20).optional(),
    role_title: z.string().max(100).optional(),
    preferred_language: z.enum(['en', 'th', 'sv']),
    date_of_birth: z.string().optional(),
  }),
});

export type MemberFormValues = z.infer<typeof memberFormSchema>;

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

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="mt-1 text-xs text-destructive" role="alert">
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
  const submitLabel = mode === 'edit' ? tEdit('submit') : t('submit');
  const submittingLabel =
    mode === 'edit' ? tEdit('submitting') : t('submitting');
  const cancelLabel = mode === 'edit' ? tEdit('cancel') : t('cancel');

  const {
    register,
    handleSubmit,
    watch,
    control,
    formState: { errors },
  } = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
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
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
      {/* FR-035 part (c): form-top required fields note */}
      <p className="text-sm text-muted-foreground" id="required-fields-note">
        {t('requiredNote')}
      </p>

      {/* --- Company section --- */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
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
            aria-describedby="required-fields-note"
            autoComplete="organization"
            maxLength={200}
          />
          <FieldError message={errors.company_name?.message} />
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
              maxLength={2}
              autoComplete="country"
              placeholder="TH"
              className="uppercase"
            />
            <FieldError message={errors.country?.message} />
          </div>
          <div>
            <Label htmlFor="tax_id">{tf('taxId')}</Label>
            <Input id="tax_id" {...register('tax_id')} maxLength={50} />
            {countryIsTH && (
              <p className="mt-1 text-xs text-muted-foreground">
                {tf('taxIdHintTH')}
              </p>
            )}
            <FieldError message={errors.tax_id?.message} />
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
              placeholder="https://…"
            />
            <FieldError message={errors.website?.message} />
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
                    className="w-full"
                  >
                    {/* base-ui Select.Value doesn't auto-resolve
                        the matching SelectItem's text — it shows the
                        raw value unless we pass a render function that
                        maps value → display. Lookup against the plans
                        array; fall back to placeholder when unset. */}
                    <SelectValue placeholder={tf('planPlaceholder')}>
                      {(value: string | null) => {
                        const match = value
                          ? plans.find((p) => p.plan_id === value)
                          : null;
                        return match ? match.display_name : tf('planPlaceholder');
                      }}
                    </SelectValue>
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
            <FieldError message={errors.plan_id?.message} />
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
              {...register('plan_year')}
            />
            <FieldError message={errors.plan_year?.message} />
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

      {/* --- Primary contact section --- */}
      <fieldset className="flex flex-col gap-4 rounded-md border p-4">
        <legend className="px-2 text-sm font-semibold">
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
              autoComplete="given-name"
              maxLength={100}
            />
            <FieldError
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
              autoComplete="family-name"
              maxLength={100}
            />
            <FieldError
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
              autoComplete="email"
              maxLength={254}
            />
            <FieldError message={errors.primary_contact?.email?.message} />
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
            />
            <FieldError message={errors.primary_contact?.phone?.message} />
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
                    <SelectValue>
                      {(value: string | null) =>
                        (value ?? 'en').toUpperCase()
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">EN</SelectItem>
                    <SelectItem value="th">TH</SelectItem>
                    <SelectItem value="sv">SV</SelectItem>
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
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
