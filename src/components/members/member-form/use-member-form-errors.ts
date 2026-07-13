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
};

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
}: MemberFormErrorsInput): readonly FormErrorSummaryItem[] {
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
  return summaryEntries
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
    .map(([fieldId, message]) => ({ fieldId, message }));
}
