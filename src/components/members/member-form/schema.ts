/**
 * T053 — Member form zod schema + shared value types.
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4) so the composition root + sections can share `MemberFormValues`
 * without a circular import back through the component.
 */

import { z } from 'zod';
import type { Path } from 'react-hook-form';
import { isVatRegistrantEntityType } from '@/lib/legal-entity';
// Deep import (NOT the `@/modules/members` barrel) — phone.ts is pure TS
// (pulls only `@/lib/result`) so it is safe in this client component and
// keeps the E.164 rule single-sourced with the domain value object.
import { isAcceptablePhoneInput } from '@/modules/members/domain/value-objects/phone';
// Deep imports (no framework deps — same pattern as phone) so the client
// mirrors the server's Thai tax-id checksum + ISO-3166 country validity and
// rejects a bad value inline instead of on a 400 round-trip.
import { validateThaiTaxIdChecksum } from '@/modules/members/domain/policies/thai-tax-id-checksum';
import { isIsoCountryCode } from '@/modules/members/domain/value-objects/iso-country-code';
import { type Translator } from '@/lib/zod-i18n';

// --- Form shape --------------------------------------------------------------

/**
 * PR-B task 7 — normalises a bare domain (e.g. "facebook.com/x") into a full
 * URL by prefixing `https://` BEFORE the `.url()` check below runs. Without
 * this, `z.string().url()` rejects anything the admin didn't already type
 * `https://` in front of — the single most common thing an admin pastes into
 * a "Website" field is a bare domain or a Facebook page slug.
 *
 * Runs via `z.preprocess` (executes ahead of the inner schema), so an
 * already-complete `http(s)://` URL passes through byte-for-byte unchanged,
 * and a non-string / blank value is left alone so the downstream
 * `.optional().or(z.literal(''))` branches still see what they expect.
 */
function normalizeWebsiteUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '' || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

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
  // PR-B task 6 — gates the address completeness rule below. Defaults to
  // 'create' (fail-safe): a caller that forgets to pass this explicitly gets
  // the STRICTER behaviour (over-blocks) rather than silently disabling the
  // completeness gate a §86/4 tax invoice depends on. The one real call site
  // (member-form.tsx) always passes the component's own `mode` prop explicitly.
  mode: 'create' | 'edit' = 'create',
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
  website: z.preprocess(
    normalizeWebsiteUrl,
    z
      .string()
      .max(200, tv('tooLong', { max: 200 }))
      .url(tf('errors.url'))
      .optional()
      .or(z.literal('')),
  ),
  description: z.string().max(2000, tv('tooLong', { max: 2000 })).optional(),
  address_line1: z.string().max(200, tv('tooLong', { max: 200 })).optional(),
  address_line2: z.string().max(200, tv('tooLong', { max: 200 })).optional(),
  city: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
  province: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
  postal_code: z.string().max(20, tv('tooLong', { max: 20 })).optional(),
  // PR-B task 6 — แขวง/ตำบล. Sits between address_line2 and city in a Thai
  // address; threaded onto the §86/4 buyer address by composeBuyerAddress
  // (invoicing module, Task 2). TH-only in the UI, but not `.nullable()` —
  // mirrors city/province/postal_code's shape exactly.
  sub_district: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
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
  // Review fix (Task 7): `turnover_thb` is a `bigint` column (no decimals),
  // and the SERVER schema requires `z.number().int()`. This used to check
  // `Number.isFinite`, so a fractional value like "1.5" passed here and only
  // got rejected by the server's `int()` rule — a 400 `invalid_body` that
  // `mapMemberCreateServerError` has no case for, surfacing as a generic
  // toast with nothing highlighted. `Number.isInteger` rejects it inline.
  turnover_thb: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isInteger(v) && v >= 0),
      tf('errors.turnover'),
    ),
  // PR-B task 7 — ทุนจดทะเบียน (registered capital). A SEPARATE field from
  // `turnover_thb` above — NOT a rename. `turnover_thb` gates the F2 plan
  // turnover band (out-of-band ⇒ mandatory override reason) and drives F8
  // auto tier-upgrade suggestions; renaming it would silently re-point a
  // membership-tier business rule at a different quantity. See the hint
  // rendered under turnover_thb in company-section.tsx.
  // Review fix (Task 7) — same bigint-column / server-int() reasoning as
  // turnover_thb above.
  registered_capital_thb: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : Number(v)))
    .refine(
      (v) => v === undefined || (Number.isInteger(v) && v >= 0),
      tf('errors.registeredCapital'),
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
  // PR-B task 8 — optional secondary contact. `undefined` until the admin
  // clicks "+ Add a secondary contact" (SecondaryContactSection); Remove
  // clears it back to `undefined` via RHF `unregister`, so this branch only
  // validates when the fieldset is actually mounted. Same shape as
  // primary_contact MINUS date_of_birth (primary-only, plan-driven gate).
  secondary_contact: z
    .object({
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
      phone: z
        .string()
        .max(20, tv('tooLong', { max: 20 }))
        .optional()
        .refine((v) => v === undefined || isAcceptablePhoneInput(v), {
          message: tf('phoneError'),
        }),
      role_title: z.string().max(100, tv('tooLong', { max: 100 })).optional(),
      preferred_language: z.enum(['en', 'th', 'sv']),
    })
    .optional(),
  }).superRefine((data, ctx) => {
    // PR-B task 8 — cheap guard for the commonest secondary-contact
    // conflict, checked client-side BEFORE any round-trip: the two contacts
    // cannot share an email (mirrors the server's
    // `secondary_email_same_as_primary` defense-in-depth check). Only fires
    // once the secondary fieldset is actually filled in — a case-insensitive
    // compare since the DB uniqueness (`contacts_tenant_email_uniq`) is on
    // `lower(email)`.
    if (
      data.secondary_contact?.email &&
      data.primary_contact?.email &&
      data.secondary_contact.email.trim().toLowerCase() ===
        data.primary_contact.email.trim().toLowerCase()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['secondary_contact', 'email'],
        message: tf('errors.secondaryEmailSameAsPrimary'),
      });
    }
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
    // PR-B task 6 — address completeness gate. CREATE ONLY: an incomplete
    // address on an EXISTING (imported) member must never block an unrelated
    // edit (e.g. fixing an email) — same trap PR-0 avoided for
    // `registration_date`. The edit form shows a persistent banner instead
    // (address-section.tsx), computed independently of this schema.
    if (mode === 'create') {
      const addressLine1 = data.address_line1?.trim();
      const city = data.city?.trim();
      if (!addressLine1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['address_line1'],
          message: tf('errors.required'),
        });
      }
      if (!city) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['city'],
          message: tf('errors.required'),
        });
      }
      // TH additionally requires province + sub_district + postal_code — the
      // §86/4 buyer-address particulars. Non-TH (e.g. Hong Kong, UAE) may have
      // no postal code at all, and has no province/sub_district concept.
      if ((data.country ?? '').toUpperCase() === 'TH') {
        if (!data.province?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['province'],
            message: tf('errors.required'),
          });
        }
        if (!data.sub_district?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['sub_district'],
            message: tf('errors.required'),
          });
        }
        if (!data.postal_code?.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['postal_code'],
            message: tf('errors.required'),
          });
        }
      }
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

export type PlanOption = {
  readonly plan_id: string;
  readonly plan_year: number;
  readonly display_name: string;
  /** When set, the plan requires DOB on the primary contact (Thai Alumni etc.). */
  readonly requires_date_of_birth?: boolean;
};
