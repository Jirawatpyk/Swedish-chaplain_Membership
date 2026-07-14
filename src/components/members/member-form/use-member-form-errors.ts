/**
 * MemberForm error-summary derivation.
 *
 * Extracted from the former single-file `member-form.tsx` (pure move, PR-B
 * task 4). Maps react-hook-form's `errors` tree onto the top-of-form error
 * summary (audit XF-09) — one entry per failing field, keyed by the field's
 * DOM id so `FormErrorSummary` can render a `#id` jump link.
 */
import { type FieldErrors } from 'react-hook-form';
import { type FormErrorSummaryItem } from '@/components/ui/form-error-summary';
import { type MemberFormValues } from './schema';

export type MemberFormErrorsInput = {
  readonly errors: FieldErrors<MemberFormValues>;
  /** Only surface the DOB entry when the field is actually rendered
   * (needsDob) — otherwise a stale DOB error after switching to a
   * non-DOB plan would make the summary jump-link point at an unmounted
   * #date_of_birth. */
  readonly needsDob: boolean;
  readonly mode: 'create' | 'edit';
  /** Only surface the branch_code entry when the input is actually
   * rendered (edit mode + NOT head office); otherwise a stale error
   * would point the jump-link at an unmounted #branch_code. */
  readonly isHeadOffice: boolean;
  /**
   * `admin.members.create.fields` translator — the SAME one every section
   * already uses for its own `<Label>`. Reused (not a bespoke set of
   * summary-only strings) so a summary line always names a field the exact
   * way that field names itself; two independent copies of the same label
   * would drift the moment only one of them is edited.
   */
  readonly tf: (key: string) => string;
  /**
   * Localised "Secondary contact" section heading
   * (`admin.members.create.sections.secondaryContact`), prefixed onto the
   * secondary contact's field labels below. `ContactFields` renders the
   * SAME label keys (First name / Last name / Email / …) for both the
   * primary and secondary contact — without this prefix two empty `email`
   * fields would produce two summary lines reading the byte-identical
   * "Email — This field is required.", which is exactly the anonymous-line
   * bug this file exists to prevent, just moved one level down.
   */
  readonly secondaryContactLabel: string;
};

/** `secondary_contact.*` shares label keys with `primary_contact.*`
 * (`ContactFields` renders the same fieldset twice) — prefix the section
 * name so the two never render an identical line. */
function secondaryFieldLabel(secondaryContactLabel: string, fieldLabel: string): string {
  return `${secondaryContactLabel}: ${fieldLabel}`;
}

/**
 * Error-summary items (RHF path → DOM id) for the top-of-form summary on a
 * long scrolling form (audit XF-09). RHF's shouldFocusError still moves focus
 * to the first field, so the summary is autoFocus={false}: it renders, lists
 * every error with a jump link, and announces via role="alert".
 */
export function useMemberFormErrors({
  errors,
  needsDob,
  mode,
  isHeadOffice,
  tf,
  secondaryContactLabel,
}: MemberFormErrorsInput): readonly FormErrorSummaryItem[] {
  const summaryEntries: ReadonlyArray<readonly [string, string, string | undefined]> = [
    ['company_name', tf('companyName'), errors.company_name?.message],
    ['legal_entity_type', tf('legalEntityType'), errors.legal_entity_type?.message],
    ['country', tf('country'), errors.country?.message],
    ['tax_id', tf('taxId'), errors.tax_id?.message],
    ['website', tf('website'), errors.website?.message],
    ['description', tf('description'), errors.description?.message],
    ['notes', tf('notes'), errors.notes?.message],
    ['founded_year', tf('foundedYear'), errors.founded_year?.message],
    ['turnover_thb', tf('turnoverThb'), errors.turnover_thb?.message],
    [
      'registered_capital_thb',
      tf('registeredCapitalThb'),
      errors.registered_capital_thb?.message,
    ],
    ['plan_id', tf('plan'), errors.plan_id?.message],
    ['plan_year', tf('planYear'), errors.plan_year?.message],
    ['address_line1', tf('addressLine1'), errors.address_line1?.message],
    ['address_line2', tf('addressLine2'), errors.address_line2?.message],
    ['city', tf('city'), errors.city?.message],
    ['province', tf('province'), errors.province?.message],
    ['postal_code', tf('postalCode'), errors.postal_code?.message],
    ['sub_district', tf('subDistrict'), errors.sub_district?.message],
    ['first_name', tf('firstName'), errors.primary_contact?.first_name?.message],
    ['last_name', tf('lastName'), errors.primary_contact?.last_name?.message],
    ['contact_email', tf('email'), errors.primary_contact?.email?.message],
    ['contact_phone', tf('phone'), errors.primary_contact?.phone?.message],
    ['role_title', tf('roleTitle'), errors.primary_contact?.role_title?.message],
    [
      'date_of_birth',
      tf('dateOfBirth'),
      needsDob ? errors.primary_contact?.date_of_birth?.message : undefined,
    ],
    // 088 US3 — only when the branch_code input is actually rendered (edit mode +
    // NOT head office); otherwise a stale error would point the jump-link at an
    // unmounted #branch_code.
    [
      'branch_code',
      tf('branchCode'),
      mode === 'edit' && !isHeadOffice
        ? errors.branch_code?.message
        : undefined,
    ],
    // PR-B task 8 — secondary contact fields. CREATE only (the section
    // never renders in edit mode); DOM ids come from ContactFields'
    // `fieldId('secondary_contact', <field>)` fallback branch
    // (`${idPrefix}_${field}` since idPrefix !== 'contact'). Labels are
    // prefixed with the section name — see `secondaryFieldLabel` above.
    [
      'secondary_contact_first_name',
      secondaryFieldLabel(secondaryContactLabel, tf('firstName')),
      mode === 'create'
        ? errors.secondary_contact?.first_name?.message
        : undefined,
    ],
    [
      'secondary_contact_last_name',
      secondaryFieldLabel(secondaryContactLabel, tf('lastName')),
      mode === 'create'
        ? errors.secondary_contact?.last_name?.message
        : undefined,
    ],
    [
      'secondary_contact_email',
      secondaryFieldLabel(secondaryContactLabel, tf('email')),
      mode === 'create' ? errors.secondary_contact?.email?.message : undefined,
    ],
    [
      'secondary_contact_phone',
      secondaryFieldLabel(secondaryContactLabel, tf('phone')),
      mode === 'create' ? errors.secondary_contact?.phone?.message : undefined,
    ],
    [
      'secondary_contact_role_title',
      secondaryFieldLabel(secondaryContactLabel, tf('roleTitle')),
      mode === 'create'
        ? errors.secondary_contact?.role_title?.message
        : undefined,
    ],
  ];
  return summaryEntries
    .filter((entry): entry is readonly [string, string, string] => Boolean(entry[2]))
    .map(([fieldId, label, message]) => ({ fieldId, label, message }));
}
