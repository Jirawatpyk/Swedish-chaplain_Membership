/**
 * Task 11 (054-event-fee-invoices) — non-member buyer sub-form.
 *
 * Rendered by `<EventFeeForm>` when the selected attendee is NOT a matched
 * member (`matchType` ∈ {non_member, unmatched}). Captures the manual buyer
 * identity that `createEventInvoiceDraft` pins into the
 * `member_identity_snapshot` at draft time (there is no F3 record to
 * re-read at issue for a non-member).
 *
 * Validation mirrors `createEventInvoiceDraftSchema.buyer` exactly so the
 * client surfaces per-field inline errors BEFORE the round-trip:
 *   - legal_name  : required, ≤ 500
 *   - address     : required, ≤ 1000
 *   - tax_id      : empty OR `^\d{13}$`
 *   - contact_*   : optional; email must be a valid address when non-empty
 *
 * Controlled: the parent owns `value` + `onChange`. Errors are computed by
 * the parent (single source of truth on submit) and passed down so the
 * field `aria-invalid` / `aria-describedby` wiring stays declarative.
 */
'use client';

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type NonMemberBuyer = {
  readonly legalName: string;
  readonly address: string;
  readonly taxId: string;
  readonly contactName: string;
  readonly contactEmail: string;
};

export type NonMemberBuyerErrors = Partial<
  Record<'legalName' | 'address' | 'taxId' | 'contactEmail', string>
>;

export const EMPTY_NON_MEMBER_BUYER: NonMemberBuyer = {
  legalName: '',
  address: '',
  taxId: '',
  contactName: '',
  contactEmail: '',
};

const TAX_ID_RE = /^\d{13}$/;
// Same shape as zod's `.email()` default (RFC-ish, no spaces, single @).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Pure field-level validator. Returns an error map keyed by the i18n leaf
 * (`legalNameRequired` / `legalNameTooLong`, `addressRequired` /
 * `addressTooLong`, `taxIdFormat`, `contactEmailFormat`) — the parent
 * resolves the key to a localised string. Exported so it can be unit-tested
 * in isolation (no DOM).
 *
 * W3 — the `> max` branch returns a DISTINCT `*TooLong` key (was reusing the
 * `*Required` key, which mislabelled a 501-char name as "required").
 */
export function validateNonMemberBuyer(
  buyer: NonMemberBuyer,
): Record<'legalName' | 'address' | 'taxId' | 'contactEmail', string | null> {
  const legalName =
    buyer.legalName.trim().length === 0
      ? 'legalNameRequired'
      : buyer.legalName.trim().length > 500
        ? 'legalNameTooLong'
        : null;
  const address =
    buyer.address.trim().length === 0
      ? 'addressRequired'
      : buyer.address.trim().length > 1000
        ? 'addressTooLong'
        : null;
  const taxId =
    buyer.taxId.trim().length > 0 && !TAX_ID_RE.test(buyer.taxId.trim())
      ? 'taxIdFormat'
      : null;
  const contactEmail =
    buyer.contactEmail.trim().length > 0 && !EMAIL_RE.test(buyer.contactEmail.trim())
      ? 'contactEmailFormat'
      : null;
  return { legalName, address, taxId, contactEmail };
}

/** True when the buyer passes all field validations. */
export function isNonMemberBuyerValid(buyer: NonMemberBuyer): boolean {
  const errors = validateNonMemberBuyer(buyer);
  return Object.values(errors).every((e) => e === null);
}

export function NonMemberBuyerFields({
  value,
  onChange,
  errors,
  disabled,
}: {
  readonly value: NonMemberBuyer;
  readonly onChange: (next: NonMemberBuyer) => void;
  readonly errors: NonMemberBuyerErrors;
  readonly disabled?: boolean;
}) {
  const t = useTranslations('admin.invoices.eventFeeForm.buyer');

  function patch(field: keyof NonMemberBuyer, next: string) {
    onChange({ ...value, [field]: next });
  }

  return (
    <fieldset
      className="flex flex-col gap-[var(--page-section-gap)] rounded-md border p-4"
      data-testid="non-member-buyer"
    >
      <legend className="px-1 text-sm font-medium">{t('nonMemberLegend')}</legend>

      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label htmlFor="buyer-legal-name">
          {t('legalName')}
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        </Label>
        <Input
          id="buyer-legal-name"
          value={value.legalName}
          onChange={(e) => patch('legalName', e.target.value)}
          placeholder={t('legalNamePlaceholder')}
          maxLength={500}
          disabled={disabled}
          autoComplete="organization"
          aria-required="true"
          aria-invalid={errors.legalName ? true : undefined}
          aria-describedby={errors.legalName ? 'buyer-legal-name-error' : undefined}
        />
        {errors.legalName && (
          <p id="buyer-legal-name-error" className="text-xs text-destructive" role="alert">
            {errors.legalName}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label htmlFor="buyer-address">
          {t('address')}
          <span aria-hidden="true" className="ml-0.5 text-destructive">
            *
          </span>
        </Label>
        <Textarea
          id="buyer-address"
          value={value.address}
          onChange={(e) => patch('address', e.target.value)}
          placeholder={t('addressPlaceholder')}
          maxLength={1000}
          disabled={disabled}
          autoComplete="street-address"
          aria-required="true"
          aria-invalid={errors.address ? true : undefined}
          aria-describedby={errors.address ? 'buyer-address-error' : undefined}
        />
        {errors.address && (
          <p id="buyer-address-error" className="text-xs text-destructive" role="alert">
            {errors.address}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label htmlFor="buyer-tax-id">{t('taxId')}</Label>
        <Input
          id="buyer-tax-id"
          value={value.taxId}
          onChange={(e) => patch('taxId', e.target.value)}
          placeholder={t('taxIdPlaceholder')}
          inputMode="numeric"
          maxLength={13}
          disabled={disabled}
          aria-invalid={errors.taxId ? true : undefined}
          aria-describedby={errors.taxId ? 'buyer-tax-id-error' : undefined}
        />
        {errors.taxId && (
          <p id="buyer-tax-id-error" className="text-xs text-destructive" role="alert">
            {errors.taxId}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label htmlFor="buyer-contact-name">{t('contactName')}</Label>
        <Input
          id="buyer-contact-name"
          value={value.contactName}
          onChange={(e) => patch('contactName', e.target.value)}
          maxLength={500}
          disabled={disabled}
          autoComplete="name"
        />
      </div>

      <div className="flex flex-col gap-[var(--field-label-gap)]">
        <Label htmlFor="buyer-contact-email">{t('contactEmail')}</Label>
        <Input
          id="buyer-contact-email"
          type="email"
          value={value.contactEmail}
          onChange={(e) => patch('contactEmail', e.target.value)}
          disabled={disabled}
          autoComplete="email"
          aria-invalid={errors.contactEmail ? true : undefined}
          aria-describedby={errors.contactEmail ? 'buyer-contact-email-error' : undefined}
        />
        {errors.contactEmail && (
          <p id="buyer-contact-email-error" className="text-xs text-destructive" role="alert">
            {errors.contactEmail}
          </p>
        )}
      </div>
    </fieldset>
  );
}
