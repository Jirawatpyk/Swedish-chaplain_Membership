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

import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller, type Path } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslations } from 'next-intl';
import { isVatRegistrantEntityType } from '@/lib/legal-entity';
import { Loader2Icon } from 'lucide-react';
// Deep import (NOT the `@/modules/members` barrel) — phone.ts is pure TS
// (pulls only `@/lib/result`) so it is safe in this client component and
// keeps the E.164 rule single-sourced with the domain value object.
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';
// Deep imports (no framework deps — same pattern as phone) so the client
// mirrors the server's Thai tax-id checksum + ISO-3166 country validity and
// rejects a bad value inline instead of on a 400 round-trip.
import { validateThaiTaxIdChecksum } from '@/modules/members/domain/policies/thai-tax-id-checksum';
import { isIsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code';
import { Input } from '@/components/ui/input';
import { EmailInput } from '@/components/ui/email-input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { FormErrorSummary } from '@/components/ui/form-error-summary';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { type Translator } from '@/lib/zod-i18n';

// --- Form shape --------------------------------------------------------------

// A2 — schema is built per-render via this factory so zod validation messages
// resolve through the active-locale translator (TH/SV previously saw hardcoded
// English). `tf` is the `admin.members.create.fields` translator, widened to
// (key) => string at the call site (next-intl's namespaced key typing doesn't
// structurally match a plain string param). Mirrors the in-component schema
// pattern in contact-form-dialog.tsx.
// Exported for the schema-level unit test (the superRefine TH-gating + country
// shape-guard wiring). The component builds it per-render via the memo below.
export function buildMemberFormSchema(
  tf: (key: string) => string,
  tv: Translator,
  // When the selected plan requires it (Thai Alumni etc.), the DOB field is
  // shown with a required asterisk — so the schema must actually enforce it,
  // not silently accept an empty value the server then rejects (audit). Default
  // false keeps the 2-arg call sites (and the schema unit test) unchanged.
  requireDob = false,
) {
  const currentYear = new Date().getUTCFullYear();
  return z.object({
  company_name: z
    .string()
    .trim()
    .min(1, tf('errors.required'))
    .max(200, tv('tooLong', { max: 200 })),
  legal_entity_type: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
  country: z
    .string()
    .length(2, tf('errors.countryCode'))
    .regex(/^[A-Za-z]{2}$/, tf('errors.countryCode')),
  tax_id: z.string().max(50, tv('tooLong', { max: 50 })).optional(),
  website: z
    .string()
    .max(200, tv('tooLong', { max: 200 }))
    .url(tf('errors.url'))
    .optional()
    .or(z.literal('')),
  description: z.string().max(2000, tv('tooLong', { max: 2000 })).optional(),
  address_line1: z.string().max(200, tv('tooLong', { max: 200 })).optional(),
  address_line2: z.string().max(200, tv('tooLong', { max: 200 })).optional(),
  city: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
  province: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
  postal_code: z.string().max(20, tv('tooLong', { max: 20 })).optional(),
  // 088 US3 (FR-008) — §86/4 Head-Office / Branch particular. Rendered on the
  // EDIT form only (tax-critical, admin-managed). `is_head_office` defaults true
  // (สำนักงานใหญ่); a branch carries a 5-digit `branch_code`. The 5-digit +
  // registrant checks live in the superRefine so a blank code on a head office
  // never trips the base rule.
  is_head_office: z.boolean().optional(),
  branch_code: z.string().nullable().optional(),
  founded_year: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isInteger(v) && v >= 1800 && v <= currentYear),
      tf('errors.foundedYear'),
    ),
  turnover_thb: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isFinite(v) && v >= 0),
      tf('errors.turnover'),
    ),
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
    .max(4000, tv('tooLong', { max: 4000 }))
    .nullable()
    .optional()
    .transform((v) =>
      v === '' || v === undefined || v === null ? null : v,
    ),
  primary_contact: z.object({
    first_name: z
      .string()
      .trim()
      .min(1, tf('errors.required'))
      .max(100, tv('tooLong', { max: 100 })),
    last_name: z
      .string()
      .trim()
      .min(1, tf('errors.required'))
      .max(100, tv('tooLong', { max: 100 })),
    email: z
      .string()
      .trim()
      .min(1, tf('errors.required'))
      .email(tf('errors.emailFormat'))
      .max(254, tv('tooLong', { max: 254 })),
    // Phone must be E.164 (matches the `asPhone` domain value object used
    // by create-member + updateContactFields). Validating client-side
    // highlights the field inline instead of letting the server reject it
    // with a 400 that surfaces only as a generic "fix highlighted fields"
    // toast with nothing actually highlighted. Empty is allowed (optional);
    // spaces / dashes / parens are stripped before the format check so
    // "+66 81-234-5678" is accepted and normalised server-side.
    phone: z
      .string()
      .max(20, tv('tooLong', { max: 20 }))
      .optional()
      .refine((v) => v === undefined || isAcceptablePhoneInput(v), {
        message: tf('phoneError'),
      }),
    role_title: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
    preferred_language: z.enum(['en', 'th', 'sv']),
    date_of_birth: z.string().optional(),
  }),
  }).superRefine((data, ctx) => {
    // Mirror the server's Thai tax-id checksum so a bad value is rejected +
    // highlighted inline (like the email .email() rule) instead of via a 400
    // round-trip — whose highlight briefly clears on the next resubmit because
    // the base tax_id rule is only max(50) and can't see the checksum. Only TH
    // tax-ids carry the Mod-11 check digit; non-TH ids stay length-only.
    const taxId = data.tax_id?.trim();
    if (
      taxId &&
      (data.country ?? '').toUpperCase() === 'TH' &&
      !validateThaiTaxIdChecksum(taxId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tax_id'],
        message: tf('errors.taxIdChecksum'),
      });
    }
    // The base country rule only checks the 2-letter SHAPE, so e.g. "ZZ" passes
    // it but the server's ISO-3166 lookup rejects it. Mirror that here (guarded
    // on a well-formed code so we don't double up with the shape error).
    if (
      data.country &&
      /^[A-Za-z]{2}$/.test(data.country) &&
      !isIsoCountryCode(data.country.toUpperCase())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['country'],
        message: tf('errors.countryCode'),
      });
    }
    // Conditional DOB requirement (Thai Alumni etc.): the field renders with a
    // required asterisk only when the plan needs it, so enforce it here rather
    // than letting the server reject an empty value with a generic toast.
    if (requireDob && !data.primary_contact?.date_of_birth?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['primary_contact', 'date_of_birth'],
        message: tf('errors.dobRequired'),
      });
    }
    // 088 US3 (FR-008) — §86/4 branch cross-field validation. A branch (NOT head
    // office) requires a 5-digit code AND is only valid for a VAT-registrant
    // juristic buyer (legal_entity_type set and ≠ 'individual'; the same
    // discriminator the identity adapter uses for `buyer_is_vat_registrant`).
    // A head office skips this (its code is cleared before submit). Mirrors the
    // server updateMember superRefine + the `members_branch_pairing_ck` DB CHECK.
    if (data.is_head_office === false) {
      const code = data.branch_code?.trim() ?? '';
      if (!/^\d{5}$/.test(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['branch_code'],
          message: tf('errors.branchCodeFormat'),
        });
      }
      if (!isVatRegistrantEntityType(data.legal_entity_type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['branch_code'],
          message: tf('errors.branchOnNonRegistrant'),
        });
      }
    }
  });
}

export type MemberFormValues = z.infer<
  ReturnType<typeof buildMemberFormSchema>
>;

/**
 * A server-rejected field, resolved to a display message. Shared by the
 * `serverFieldError` prop + both client wrappers' state so the shape stays in
 * one place (was duplicated inline across three sites). `field` is a real RHF
 * path so `setError` against it is compile-checked.
 */
export type ResolvedServerFieldError = {
  readonly field: Path<MemberFormValues>;
  readonly message: string;
};

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
  /**
   * A server-rejected field (POST 400/409) to surface inline: highlights +
   * focuses the input and shows `message` under it, instead of a generic
   * toast with nothing marked. Each new object reference re-applies the error.
   */
  readonly serverFieldError?: ResolvedServerFieldError | null;
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
  serverFieldError,
}: Props) {
  // Shared copy (section headers, required note, field labels) lives
  // under `admin.members.create.*` since it's identical for create +
  // edit. Only the submit button + submitting label differ per mode —
  // those resolve via `submitLabel` / `submittingLabel` below.
  const t = useTranslations('admin.members.create');
  const tEdit = useTranslations('admin.members.edit');
  const tf = useTranslations('admin.members.create.fields');
  const tv = useTranslations('shared.validation');
  const tLang = useTranslations('common');
  const submitLabel = mode === 'edit' ? tEdit('submit') : t('submit');
  const submittingLabel =
    mode === 'edit' ? tEdit('submitting') : t('submitting');
  const cancelLabel = mode === 'edit' ? tEdit('cancel') : t('cancel');

  // Track the selected plan in local state (not RHF `watch`) so the schema can
  // be rebuilt with the conditional-DOB requirement BEFORE useForm consumes the
  // resolver — avoids the watch()→useForm circular dependency.
  const [planId, setPlanId] = useState<string>(initialValues?.plan_id ?? '');
  const selectedPlan = plans.find((p) => p.plan_id === planId);
  const needsDob = Boolean(selectedPlan?.requires_date_of_birth);

  // Build the zod schema with the active-locale field-error translator + the
  // conditional DOB requirement. `tf` is stable per locale render (next-intl);
  // the memo re-runs on a locale switch or when the plan toggles DOB-required.
  const schema = useMemo(
    () =>
      buildMemberFormSchema(
        tf as (key: string) => string,
        tv as Translator,
        needsDob,
      ),
    [tf, tv, needsDob],
  );

  const {
    register,
    handleSubmit,
    control,
    setError,
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

  const [country, setCountry] = useState<string>(
    initialValues?.country ?? 'TH',
  );
  const countryIsTH = country.toUpperCase() === 'TH';

  // 088 US3 (FR-008) — the head-office toggle drives the conditional 5-digit
  // branch_code input (rendered on the EDIT form only). Local state so the
  // conditional field mounts/unmounts without a RHF `watch()` dependency loop.
  const [isHeadOffice, setIsHeadOffice] = useState<boolean>(
    initialValues?.is_head_office ?? true,
  );

  // Surface a server-rejected field (email-in-use, bad tax-id checksum, …)
  // inline: highlight + focus the originating input per WCAG 3.3.1 instead of
  // the old generic toast with nothing marked. A new `serverFieldError` object
  // reference (one per failed submit) re-runs this even for the same field.
  //
  // INVARIANT: this only SETS an error, never clears it. Two separate
  // mechanisms keep that safe: (1) a `type:'server'` error is removed by RHF's
  // resolver re-running on the next submit (every submit runs the resolver; the
  // field then passes its own zod rule) — this is what actually clears the
  // highlight; (2) the parent resets serverFieldError to null at the start of
  // each submit purely so this effect does not RE-APPLY a stale error (the
  // effect early-returns on null). Nulling the prop does not itself clear the
  // RHF error. If a future caller nulls it expecting the highlight to vanish
  // WITHOUT a resubmit (a "dismiss" affordance), add a clearErrors() here.
  useEffect(() => {
    if (!serverFieldError) return;
    setError(
      serverFieldError.field,
      { type: 'server', message: serverFieldError.message },
      { shouldFocus: true },
    );
  }, [serverFieldError, setError]);

  // Error-summary items (RHF path → DOM id) for the top-of-form summary on a
  // long scrolling form (audit XF-09). RHF's shouldFocusError still moves focus
  // to the first field, so the summary is autoFocus={false}: it renders, lists
  // every error with a jump link, and announces via role="alert".
  const summaryEntries: ReadonlyArray<readonly [string, string | undefined]> = [
    ['company_name', errors.company_name?.message],
    ['legal_entity_type', errors.legal_entity_type?.message],
    ['country', errors.country?.message],
    ['tax_id', errors.tax_id?.message],
    ['website', errors.website?.message],
    ['description', errors.description?.message],
    ['notes', errors.notes?.message],
    ['founded_year', errors.founded_year?.message],
    ['turnover_thb', errors.turnover_thb?.message],
    ['plan_id', errors.plan_id?.message],
    ['plan_year', errors.plan_year?.message],
    ['address_line1', errors.address_line1?.message],
    ['address_line2', errors.address_line2?.message],
    ['city', errors.city?.message],
    ['province', errors.province?.message],
    ['postal_code', errors.postal_code?.message],
    ['first_name', errors.primary_contact?.first_name?.message],
    ['last_name', errors.primary_contact?.last_name?.message],
    ['contact_email', errors.primary_contact?.email?.message],
    ['contact_phone', errors.primary_contact?.phone?.message],
    ['role_title', errors.primary_contact?.role_title?.message],
    // Only when the DOB field is actually rendered (needsDob) — otherwise a
    // stale DOB error after switching to a non-DOB plan would make the summary
    // jump-link point at an unmounted #date_of_birth.
    [
      'date_of_birth',
      needsDob ? errors.primary_contact?.date_of_birth?.message : undefined,
    ],
    // 088 US3 — only when the branch_code input is actually rendered (edit mode +
    // NOT head office); otherwise a stale error would point the jump-link at an
    // unmounted #branch_code.
    [
      'branch_code',
      mode === 'edit' && !isHeadOffice
        ? errors.branch_code?.message
        : undefined,
    ],
  ];
  const summaryItems = summaryEntries
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([fieldId, message]) => ({ fieldId, message }));

  return (
    <form onSubmit={handleSubmit(onSubmit)} method="post" noValidate className="flex flex-col gap-[var(--page-section-gap)]">
      {/* FR-035 part (c): form-top required fields note */}
      <p className="text-sm text-muted-foreground" id="required-fields-note">
        {t('requiredNote')}
      </p>

      {/* Summary only when MORE THAN ONE error (ux-standards § 11.3); a single
        * error is already covered by its inline field message + RHF focus. */}
      <FormErrorSummary
        title={t('errorSummaryTitle')}
        items={summaryItems.length > 1 ? summaryItems : []}
        autoFocus={false}
      />

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
                  onValueChange={(v) => {
                    field.onChange(v);
                    // Mirror to local state so the schema rebuilds with the
                    // plan's DOB requirement (see the planId state above).
                    setPlanId(v ?? '');
                  }}
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
            readOnly={mode === 'edit'}
            aria-describedby={
              mode === 'edit'
                ? 'registration_date-hint registration_date-readonly'
                : 'registration_date-hint'
            }
            className={mode === 'edit' ? 'bg-muted' : undefined}
            {...register('registration_date')}
          />
          <p
            id="registration_date-hint"
            className="mt-1 text-xs text-muted-foreground"
          >
            {tf('registrationDateHint')}
          </p>
          {mode === 'edit' && (
            <p
              id="registration_date-readonly"
              className="mt-1 text-xs text-muted-foreground"
            >
              {tf('registrationDateReadOnly')}
            </p>
          )}
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
            aria-invalid={Boolean(errors.address_line1)}
            aria-describedby={
              errors.address_line1 ? 'address_line1-error' : undefined
            }
          />
          <FieldError
            id="address_line1-error"
            message={errors.address_line1?.message}
          />
        </div>
        <div>
          <Label htmlFor="address_line2">{tf('addressLine2')}</Label>
          <Input
            id="address_line2"
            {...register('address_line2')}
            maxLength={200}
            autoComplete="address-line2"
            aria-invalid={Boolean(errors.address_line2)}
            aria-describedby={
              errors.address_line2 ? 'address_line2-error' : undefined
            }
          />
          <FieldError
            id="address_line2-error"
            message={errors.address_line2?.message}
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
              aria-invalid={Boolean(errors.city)}
              aria-describedby={errors.city ? 'city-error' : undefined}
            />
            <FieldError id="city-error" message={errors.city?.message} />
          </div>
          <div>
            <Label htmlFor="province">{tf('province')}</Label>
            <Input
              id="province"
              {...register('province')}
              maxLength={100}
              autoComplete="address-level1"
              aria-invalid={Boolean(errors.province)}
              aria-describedby={errors.province ? 'province-error' : undefined}
            />
            <FieldError id="province-error" message={errors.province?.message} />
          </div>
          <div>
            <Label htmlFor="postal_code">{tf('postalCode')}</Label>
            <Input
              id="postal_code"
              {...register('postal_code')}
              maxLength={20}
              autoComplete="postal-code"
              aria-invalid={Boolean(errors.postal_code)}
              aria-describedby={
                errors.postal_code ? 'postal_code-error' : undefined
              }
            />
            <FieldError
              id="postal_code-error"
              message={errors.postal_code?.message}
            />
          </div>
        </div>
      </fieldset>

      {/* --- Tax branch (§86/4) section — EDIT only, admin-managed --- */}
      {mode === 'edit' && (
        <fieldset className="flex flex-col gap-4 rounded-md border p-4">
          <legend className="px-2 text-base font-semibold">
            {t('sections.taxBranch')}
          </legend>
          <p className="text-xs text-muted-foreground">{tf('branchHint')}</p>
          <div className="flex items-start gap-2">
            <input
              id="is_head_office"
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input accent-primary"
              {...register('is_head_office', {
                onChange: (e) => setIsHeadOffice(e.target.checked),
              })}
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
      )}

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
            <EmailInput
              id="contact_email"
              {...register('primary_contact.email')}
              required
              aria-required="true"
              aria-invalid={Boolean(errors.primary_contact?.email)}
              aria-describedby={
                errors.primary_contact?.email
                  ? 'contact_email-error required-fields-note'
                  : 'required-fields-note'
              }
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
              aria-invalid={Boolean(errors.primary_contact?.role_title)}
              aria-describedby={
                errors.primary_contact?.role_title ? 'role_title-error' : undefined
              }
            />
            <FieldError
              id="role_title-error"
              message={errors.primary_contact?.role_title?.message}
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
              aria-invalid={Boolean(errors.primary_contact?.date_of_birth)}
              aria-describedby={
                errors.primary_contact?.date_of_birth
                  ? 'date_of_birth-error date_of_birth-hint'
                  : 'date_of_birth-hint'
              }
            />
            <p id="date_of_birth-hint" className="mt-1 text-xs text-muted-foreground">
              {tf('dateOfBirthHint')}
            </p>
            <FieldError
              id="date_of_birth-error"
              message={errors.primary_contact?.date_of_birth?.message}
            />
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
