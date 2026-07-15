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
 * Seeds in BOTH modes as of 059 / PR-A. It used to bail out on create, because
 * the checkbox rendered only on edit and `toPayload` never sent the field — so
 * seeding it would have been silent dead state. Both of those are now fixed: the
 * checkbox renders at create and the payload carries it. Leaving the bail-out in
 * would have been worse than useless — the admin picks "Limited company" at
 * create, the box does not tick, and the member is born a non-registrant.
 *
 * Returns the value to seed, or `null` when nothing should be written:
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
  readonly code: string;
  readonly vatManuallyTouched: boolean;
}): boolean | null {
  if (args.vatManuallyTouched) return null;
  if (!isLegalEntityTypeCode(args.code)) return null;
  return VAT_DEFAULT_BY_CODE[args.code];
}
