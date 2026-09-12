/**
 * F114 FR-002 — Group B: the fields a member may PROPOSE through a change
 * request (data-model.md § 3). Extends F3 FR-014a's compile-time allow-list
 * idea: one `as const` tuple is the single source for the Domain policies,
 * the Application whitelist, the DB CHECK in migration 0300 (parity-tested)
 * and the review-page rows. Adding or removing a proposable field is ONE
 * source change here plus a migration widening the CHECK.
 *
 * Group A (immediate, never a change-request key): the contact's own
 * `preferred_language` — see `portal-self-update-fields.ts`.
 * Group C (staff-only, FR-003): everything else on `members` / `contacts`.
 *
 * Address groups are single keys: a registered or billing address is
 * proposed, shown, decided and applied as ONE unit (spec § Edge Cases).
 *
 * Pure TypeScript — no framework imports.
 */

export const CONTACT_FIELD_KEYS = ['first_name', 'last_name', 'phone', 'role_title'] as const;

export const COMPANY_FIELD_KEYS = [
  'company_name',
  'website',
  'description',
  'registered_address',
  'billing_address',
] as const;

export const PROPOSABLE_FIELD_KEYS = [...CONTACT_FIELD_KEYS, ...COMPANY_FIELD_KEYS] as const;

export type ContactFieldKey = (typeof CONTACT_FIELD_KEYS)[number];
export type CompanyFieldKey = (typeof COMPANY_FIELD_KEYS)[number];
export type ProposableFieldKey = (typeof PROPOSABLE_FIELD_KEYS)[number];

export type ProposedFieldTarget = 'member' | 'contact';

/** Which record a key writes to on approval (data-model.md § 3). */
export const PROPOSABLE_FIELD_TARGET: Readonly<Record<ProposableFieldKey, ProposedFieldTarget>> = {
  first_name: 'contact',
  last_name: 'contact',
  phone: 'contact',
  role_title: 'contact',
  company_name: 'member',
  website: 'member',
  description: 'member',
  registered_address: 'member',
  billing_address: 'member',
};

/** Lines of the registered (company) address group, in display order. */
export const REGISTERED_ADDRESS_LINES = [
  'line1',
  'line2',
  'sub_district',
  'city',
  'province',
  'postal_code',
] as const;

/** Lines of the billing address group — the registered lines plus a country. */
export const BILLING_ADDRESS_LINES = [...REGISTERED_ADDRESS_LINES, 'country'] as const;

export type RegisteredAddressLine = (typeof REGISTERED_ADDRESS_LINES)[number];
export type BillingAddressLine = (typeof BILLING_ADDRESS_LINES)[number];

export type RegisteredAddress = Readonly<Record<RegisteredAddressLine, string | null>>;
export type BillingAddress = Readonly<Record<BillingAddressLine, string | null>>;

/** The two address-group keys — the only keys whose value is an object. */
export const ADDRESS_GROUP_KEYS = ['registered_address', 'billing_address'] as const;
export type AddressGroupKey = (typeof ADDRESS_GROUP_KEYS)[number];

export function isProposableFieldKey(value: string): value is ProposableFieldKey {
  return (PROPOSABLE_FIELD_KEYS as readonly string[]).includes(value);
}

export function isContactFieldKey(value: string): value is ContactFieldKey {
  return (CONTACT_FIELD_KEYS as readonly string[]).includes(value);
}

export function isCompanyFieldKey(value: string): value is CompanyFieldKey {
  return (COMPANY_FIELD_KEYS as readonly string[]).includes(value);
}

export function isAddressGroupKey(value: string): value is AddressGroupKey {
  return (ADDRESS_GROUP_KEYS as readonly string[]).includes(value);
}
