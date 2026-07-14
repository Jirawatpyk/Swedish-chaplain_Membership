/**
 * 059 / PR-A Task 3b — decides whether picking a new `legal_entity_type`
 * should seed the `is_vat_registered` checkbox, and with what value.
 *
 * Extracted to a pure function (same rationale as `edit-member-payloads.ts`'s
 * `hasFieldDiff` / `buildFieldPayload`) so the "when do we seed" decision is
 * unit-testable without rendering the form or driving a Base UI `<Select>`
 * through jsdom. `company-section.tsx` calls this from the entity-type
 * Select's `onValueChange` — a genuinely user-initiated event, never a
 * `useEffect`/`useWatch` — so there is no mount-firing class of bug to guard
 * against here (PR-B shipped a Critical for exactly that shape of bug: an
 * effect that fired on mount because `useWatch` returns `defaultValues` on
 * the first render).
 *
 * Returns the value to seed, or `null` when nothing should be written:
 *   - `mode !== 'edit'` — `is_vat_registered` only renders in
 *     `TaxBranchSection` (edit-only, same posture as `is_head_office` /
 *     `branch_code`); seeding it on create would be silent dead state
 *     (`create-member-client.tsx`'s `toPayload` never reads the field).
 *   - `code` has no safe default (`association` / `foundation` — see
 *     `VAT_DEFAULT_BY_CODE`'s docblock: VAT registration follows turnover,
 *     not legal form, and TSCC is itself a VAT-registered association).
 *   - `vatManuallyTouched` — the admin has already hand-toggled the checkbox
 *     THIS session (`tax-branch-section.tsx`'s `onCheckedChange`). Seeding is
 *     a suggestion, never a rule — it must not silently overwrite a
 *     deliberate choice.
 */
import {
  VAT_DEFAULT_BY_CODE,
  isLegalEntityTypeCode,
} from '@/modules/members/domain/value-objects/legal-entity-type';

export function resolveVatSeed(args: {
  readonly mode: 'create' | 'edit';
  readonly code: string;
  readonly vatManuallyTouched: boolean;
}): boolean | null {
  if (args.mode !== 'edit') return null;
  if (args.vatManuallyTouched) return null;
  if (!isLegalEntityTypeCode(args.code)) return null;
  return VAT_DEFAULT_BY_CODE[args.code];
}
