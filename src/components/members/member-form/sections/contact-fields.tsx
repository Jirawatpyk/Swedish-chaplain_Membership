'use client';

/**
 * MemberForm — contact fieldset content, parameterised by name-prefix.
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4) — this is the load-bearing extraction: a future secondary-contact
 * fieldset (PR-B task 8) renders this a second time with
 * `prefix="secondary_contact"` instead of duplicating the whole fieldset.
 *
 * DOM ids for the primary contact (`idPrefix="contact"`) are preserved
 * EXACTLY as they were pre-decomposition: `first_name`, `last_name`,
 * `contact_email`, `contact_phone`, `role_title`, `preferred_language`,
 * `date_of_birth` — the error summary's jump links and every existing
 * MemberForm test target these literal ids. Only `email`/`phone` ever
 * carried the `contact_` prefix in the original markup (the others were
 * bare); `fieldId()` below preserves that quirk for `idPrefix="contact"`
 * and falls back to a uniform `${idPrefix}_<field>` scheme for any other
 * idPrefix (e.g. task 8's `secondary_contact`), which avoids an id
 * collision when this component is rendered twice on the same page.
 *
 * Spec 122 US5b-2 (T577): AURA fields, two a row from 640px as the board
 * draws them; the language on an AURA `Select`, the date of birth on an AURA
 * `DatePicker` (Buddhist-era years in Thai, the value stays ISO).
 */
import { useTranslations } from 'next-intl';
import {
  Controller,
  useFormContext,
  type FieldErrors,
  type Path,
} from 'react-hook-form';
import { DatePicker, Select, TextField, type ISODate } from '@jirawatpyk/aura-react';
import { type MemberFormValues } from '../schema';

export type ContactFieldsProps = {
  readonly prefix: 'primary_contact' | 'secondary_contact';
  readonly idPrefix: string;
  readonly showDateOfBirth: boolean;
  readonly required: boolean;
};

type ContactValues = MemberFormValues['primary_contact'];

const LEGACY_BARE_FIELDS = new Set<keyof ContactValues>([
  'first_name',
  'last_name',
  'role_title',
  'preferred_language',
  'date_of_birth',
]);

function fieldId(idPrefix: string, field: keyof ContactValues): string {
  if (idPrefix === 'contact' && LEGACY_BARE_FIELDS.has(field)) {
    return field;
  }
  return `${idPrefix}_${field}`;
}

export function ContactFields({
  prefix,
  idPrefix,
  showDateOfBirth,
  required,
}: ContactFieldsProps) {
  const tf = useTranslations('admin.members.create.fields');
  const tLang = useTranslations('common');
  const {
    register,
    control,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  // `secondary_contact` is not yet part of `MemberFormValues` (PR-B task 8
  // adds it to schema.ts) — this component's prop type anticipates that
  // shape ahead of the schema so it renders a second time without a further
  // interface change. Narrow casts at the two RHF touch-points (register
  // path + error lookup) rather than widening the schema early.
  const fieldPath = (field: keyof ContactValues) =>
    `${prefix}.${field}` as Path<MemberFormValues>;
  const contactErrors = (
    errors as unknown as Record<string, FieldErrors<ContactValues> | undefined>
  )[prefix];

  const idFirstName = fieldId(idPrefix, 'first_name');
  const idLastName = fieldId(idPrefix, 'last_name');
  const idEmail = fieldId(idPrefix, 'email');
  const idPhone = fieldId(idPrefix, 'phone');
  const idRoleTitle = fieldId(idPrefix, 'role_title');
  const idPreferredLanguage = fieldId(idPrefix, 'preferred_language');
  const idDateOfBirth = fieldId(idPrefix, 'date_of_birth');

  const requiredNote = required ? 'required-fields-note' : undefined;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField
        id={idFirstName}
        label={tf('firstName')}
        required={required}
        aria-required={required ? 'true' : undefined}
        aria-describedby={requiredNote}
        autoComplete="given-name"
        maxLength={100}
        error={contactErrors?.first_name?.message}
        {...register(fieldPath('first_name'))}
      />
      <TextField
        id={idLastName}
        label={tf('lastName')}
        required={required}
        aria-required={required ? 'true' : undefined}
        aria-describedby={requiredNote}
        autoComplete="family-name"
        maxLength={100}
        error={contactErrors?.last_name?.message}
        {...register(fieldPath('last_name'))}
      />
      <TextField
        id={idEmail}
        type="email"
        inputMode="email"
        autoComplete="email"
        label={tf('email')}
        required={required}
        aria-required={required ? 'true' : undefined}
        aria-describedby={requiredNote}
        maxLength={254}
        error={contactErrors?.email?.message}
        {...register(fieldPath('email'))}
      />
      <TextField
        id={idPhone}
        type="tel"
        autoComplete="tel"
        label={tf('phone')}
        maxLength={20}
        placeholder="+66812345678"
        error={contactErrors?.phone?.message}
        {...register(fieldPath('phone'))}
      />
      <TextField
        id={idRoleTitle}
        label={tf('roleTitle')}
        maxLength={100}
        autoComplete="organization-title"
        error={contactErrors?.role_title?.message}
        {...register(fieldPath('role_title'))}
      />
      <Controller
        control={control}
        name={fieldPath('preferred_language')}
        defaultValue="en"
        render={({ field }) => (
          <Select
            id={idPreferredLanguage}
            name={field.name}
            ref={field.ref}
            onBlur={field.onBlur}
            label={tf('preferredLanguage')}
            required={required}
            // The schema pins this to z.enum(['en','th','sv']) and
            // `common.languageOptions.{en,th,sv}` exist in every locale file,
            // so every reachable value has a label.
            value={(field.value as 'en' | 'th' | 'sv' | undefined) ?? 'en'}
            options={(['en', 'th', 'sv'] as const).map((code) => ({
              value: code,
              label: tLang(`languageOptions.${code}`),
            }))}
            error={contactErrors?.preferred_language?.message}
            onChange={(e) => field.onChange(e.target.value)}
          />
        )}
      />

      {showDateOfBirth && (
        <Controller
          control={control}
          name={fieldPath('date_of_birth')}
          render={({ field }) => (
            <DatePicker
              id={idDateOfBirth}
              name={field.name}
              // The input carries RHF's ref so a failed submit can focus it.
              ref={field.ref}
              onBlur={field.onBlur}
              label={tf('dateOfBirth')}
              required
              max="today"
              timeZone="Asia/Bangkok"
              value={((field.value as string | null | undefined) || null) as ISODate | null}
              onChange={(iso) => field.onChange(iso ?? '')}
              hint={tf('dateOfBirthHint')}
              error={contactErrors?.date_of_birth?.message}
            />
          )}
        />
      )}
    </div>
  );
}
