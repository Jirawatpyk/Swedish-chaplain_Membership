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
import { TextField, Textarea } from '@jirawatpyk/aura-react';

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
 *
 * LOW-10 — `contactName` is INTENTIONALLY not validated here. The server's
 * `createEventInvoiceDraftSchema.buyer.primary_contact_name` is a bare
 * `z.string()`: it accepts an empty string (optional pre-fill, per spec) and
 * imposes NO length bound that the server rejects. The form's `maxLength={500}`
 * on the contact-name field is a soft UI cap (matching the legal-name
 * field), not a server-enforced rule, so there is nothing for the client to
 * surface an inline error about. `contactEmail` IS validated (the server
 * requires a valid address when non-empty). If the server ever adds a
 * `.min(1)` or `.max(n)` to `primary_contact_name`, add a `contactName` branch
 * here + its return-type field + i18n key to mirror it.
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

  // Spec 122 US8 (T807) — AURA fields: the required "*" (hidden from screen
  // readers, who get aria-required), the error replacing the hint and wired
  // through aria-invalid + aria-describedby (`{id}-error`). The form focuses
  // the first field in error on submit, so the error is read on arrival.
  return (
    <fieldset
      className="flex flex-col gap-[var(--aura-space-4)] rounded-[var(--aura-radius-md)] border border-[var(--aura-border-subtle)] p-[var(--aura-space-4)]"
      data-testid="non-member-buyer"
    >
      <legend className="px-1 text-sm font-medium text-[var(--aura-fg-primary)]">{t('nonMemberLegend')}</legend>

      <TextField
        id="buyer-legal-name"
        label={t('legalName')}
        required
        aria-required="true"
        value={value.legalName}
        onChange={(e) => patch('legalName', e.target.value)}
        placeholder={t('legalNamePlaceholder')}
        maxLength={500}
        disabled={disabled}
        autoComplete="organization"
        error={errors.legalName}
      />

      <Textarea
        id="buyer-address"
        label={t('address')}
        required
        aria-required="true"
        value={value.address}
        onChange={(e) => patch('address', e.target.value)}
        placeholder={t('addressPlaceholder')}
        maxLength={1000}
        disabled={disabled}
        autoComplete="street-address"
        error={errors.address}
      />

      <TextField
        id="buyer-tax-id"
        label={t('taxId')}
        value={value.taxId}
        onChange={(e) => patch('taxId', e.target.value)}
        placeholder={t('taxIdPlaceholder')}
        inputMode="numeric"
        maxLength={13}
        disabled={disabled}
        error={errors.taxId}
      />

      {/*
        LOW-10 — contact name is an OPTIONAL pre-fill. The server schema
        (`primary_contact_name: z.string()`) accepts empty + any length, so
        there is no inline error to surface; `maxLength` is a soft UI cap only.
      */}
      <TextField
        id="buyer-contact-name"
        label={t('contactName')}
        value={value.contactName}
        onChange={(e) => patch('contactName', e.target.value)}
        maxLength={500}
        disabled={disabled}
        autoComplete="name"
      />

      <TextField
        id="buyer-contact-email"
        type="email"
        label={t('contactEmail')}
        value={value.contactEmail}
        onChange={(e) => patch('contactEmail', e.target.value)}
        disabled={disabled}
        autoComplete="email"
        error={errors.contactEmail}
      />
    </fieldset>
  );
}
