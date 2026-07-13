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
 */
import { useTranslations } from 'next-intl';
import {
  Controller,
  useFormContext,
  type FieldErrors,
  type Path,
} from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { EmailInput } from '@/components/ui/email-input';
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

  return (
    <>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor={idFirstName}>
            {tf('firstName')}
            {required && <RequiredMark />}
          </Label>
          <Input
            id={idFirstName}
            {...register(fieldPath('first_name'))}
            required={required}
            aria-required={required ? 'true' : undefined}
            aria-invalid={Boolean(contactErrors?.first_name)}
            aria-describedby={
              contactErrors?.first_name
                ? `${idFirstName}-error required-fields-note`
                : required
                  ? 'required-fields-note'
                  : undefined
            }
            autoComplete="given-name"
            maxLength={100}
          />
          <FieldError
            id={`${idFirstName}-error`}
            message={contactErrors?.first_name?.message}
          />
        </div>
        <div>
          <Label htmlFor={idLastName}>
            {tf('lastName')}
            {required && <RequiredMark />}
          </Label>
          <Input
            id={idLastName}
            {...register(fieldPath('last_name'))}
            required={required}
            aria-required={required ? 'true' : undefined}
            aria-invalid={Boolean(contactErrors?.last_name)}
            aria-describedby={
              contactErrors?.last_name
                ? `${idLastName}-error required-fields-note`
                : required
                  ? 'required-fields-note'
                  : undefined
            }
            autoComplete="family-name"
            maxLength={100}
          />
          <FieldError
            id={`${idLastName}-error`}
            message={contactErrors?.last_name?.message}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor={idEmail}>
            {tf('email')}
            {required && <RequiredMark />}
          </Label>
          <EmailInput
            id={idEmail}
            {...register(fieldPath('email'))}
            required={required}
            aria-required={required ? 'true' : undefined}
            aria-invalid={Boolean(contactErrors?.email)}
            aria-describedby={
              contactErrors?.email
                ? `${idEmail}-error required-fields-note`
                : required
                  ? 'required-fields-note'
                  : undefined
            }
            maxLength={254}
          />
          <FieldError id={`${idEmail}-error`} message={contactErrors?.email?.message} />
        </div>
        <div>
          <Label htmlFor={idPhone}>{tf('phone')}</Label>
          <Input
            id={idPhone}
            type="tel"
            {...register(fieldPath('phone'))}
            autoComplete="tel"
            maxLength={20}
            placeholder="+66812345678"
            aria-invalid={Boolean(contactErrors?.phone)}
            aria-describedby={contactErrors?.phone ? `${idPhone}-error` : undefined}
          />
          <FieldError id={`${idPhone}-error`} message={contactErrors?.phone?.message} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <Label htmlFor={idRoleTitle}>{tf('roleTitle')}</Label>
          <Input
            id={idRoleTitle}
            {...register(fieldPath('role_title'))}
            maxLength={100}
            autoComplete="organization-title"
            aria-invalid={Boolean(contactErrors?.role_title)}
            aria-describedby={
              contactErrors?.role_title ? `${idRoleTitle}-error` : undefined
            }
          />
          <FieldError
            id={`${idRoleTitle}-error`}
            message={contactErrors?.role_title?.message}
          />
        </div>
        <div>
          <Label htmlFor={idPreferredLanguage}>
            {tf('preferredLanguage')}
            {required && <RequiredMark />}
          </Label>
          <Controller
            control={control}
            name={fieldPath('preferred_language')}
            render={({ field }) => (
              <Select
                value={(field.value as 'en' | 'th' | 'sv' | undefined) ?? 'en'}
                onValueChange={(v) => field.onChange(v)}
              >
                <SelectTrigger
                  id={idPreferredLanguage}
                  aria-required={required ? 'true' : undefined}
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

      {showDateOfBirth && (
        <div>
          <Label htmlFor={idDateOfBirth}>
            {tf('dateOfBirth')}
            <RequiredMark />
          </Label>
          <Input
            id={idDateOfBirth}
            type="date"
            {...register(fieldPath('date_of_birth'))}
            required
            aria-required="true"
            autoComplete="bday"
            aria-invalid={Boolean(contactErrors?.date_of_birth)}
            aria-describedby={
              contactErrors?.date_of_birth
                ? `${idDateOfBirth}-error ${idDateOfBirth}-hint`
                : `${idDateOfBirth}-hint`
            }
          />
          <p id={`${idDateOfBirth}-hint`} className="mt-1 text-xs text-muted-foreground">
            {tf('dateOfBirthHint')}
          </p>
          <FieldError
            id={`${idDateOfBirth}-error`}
            message={contactErrors?.date_of_birth?.message}
          />
        </div>
      )}
    </>
  );
}
