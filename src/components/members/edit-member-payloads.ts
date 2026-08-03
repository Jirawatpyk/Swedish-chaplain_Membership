/**
 * Pure payload builders + change detectors for the member edit flow.
 *
 * Extracted from `edit-member-client.tsx` so the bug-prone normalisation
 * (the `''`-vs-`null` trimming that decides whether a field is "changed"
 * and what gets sent) is unit-testable without rendering the form. The
 * client wrapper composes these into its multi-step PATCH sequence.
 *
 * The headline session bug was that primary-contact edits were never sent
 * at all; `contactFieldsChanged` + `buildContactPayload` are the decision
 * functions that fix it, so they get direct coverage here.
 */
import type { MemberFormValues } from './member-form';
// 065 §5.1 (final-review) — the canonical cadence union, minted alongside
// BILLING_CYCLES "so the schema enum, form, and both zod boundaries agree";
// re-declaring the literals here would let a future third cadence silently
// diverge at this layer (the exact silent-no-PATCH class hasFieldDiff's
// comments document). Type-only import — pure TS, zero framework deps
// (same review-blessed posture as member-form/schema.ts's Domain imports).
import type { BillingCycle } from '@/modules/members/domain/member';

export type MemberInitialValues = {
  readonly memberId: string;
  readonly companyName: string;
  readonly legalEntityType: string | null;
  readonly country: string;
  readonly taxId: string | null;
  readonly website: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly province: string | null;
  readonly postalCode: string | null;
  // PR-B task 6 — แขวง/ตำบล. Optional so pre-existing fixtures + the create
  // path (which never seeded it before this task) stay non-breaking — same
  // precedent as `isHeadOffice`/`branchCode` above.
  readonly subDistrict?: string | null;
  readonly foundedYear: number | null;
  readonly turnoverThb: number | null;
  // PR-B task 7 — ทุนจดทะเบียน. Optional (like `subDistrict` above) so
  // pre-existing fixtures + the create path stay non-breaking.
  readonly registeredCapitalThb?: number | null;
  readonly planId: string;
  readonly planYear: number;
  readonly registrationDate: string;
  // 088 US3 (FR-008) — §86/4 Head-Office / Branch particular. Optional so the
  // existing fixtures + create path (which never seed them) stay non-breaking;
  // the edit page always supplies them (`isHeadOffice ?? true` / `branchCode ??
  // null`). The diff helpers normalise both sides with the same defaults.
  readonly isHeadOffice?: boolean;
  readonly branchCode?: string | null;
  // 059 / PR-A — the RECORDED §86/4 VAT-registrant flag that gates the branch
  // pair above. Same optional posture, same default-normalising diff.
  readonly isVatRegistered?: boolean;
  // 065 §5.1 — per-member billing cadence. Optional (like the pair above) so
  // pre-existing fixtures stay non-breaking; the edit page always supplies it
  // (`billingCycle ?? 'rolling'`). The diff normalises both sides to 'rolling'.
  readonly billingCycle?: BillingCycle;
  // member-billing-address (0284) — optional tax-document address group.
  // Optional (fixture-non-breaking, like subDistrict above); the edit page
  // supplies them from the serialised member.
  readonly billingAddressLine1?: string | null;
  readonly billingAddressLine2?: string | null;
  readonly billingSubDistrict?: string | null;
  readonly billingCity?: string | null;
  readonly billingProvince?: string | null;
  readonly billingPostalCode?: string | null;
  readonly billingCountry?: string | null;
};

/**
 * member-billing-address (0284) — the billing group as the API expects it.
 * Toggle OFF ⇒ every field null (clears the group server-side — "set" ⟺
 * line1 IS NOT NULL, no enable flag exists). Toggle ON ⇒ trimmed values,
 * '' → null; the form zod already guaranteed line1/city/postal/country are
 * present, and the server's resulting-state check + DB CHECK back it up.
 * Shared by the create + edit payload builders so the ''-vs-null
 * normalisation can never diverge between the two flows.
 */
export function buildBillingAddressPayload(
  values: MemberFormValues,
): Record<string, string | null> {
  const on = values.billing_differs === true;
  return {
    billing_address_line1: on ? values.billing_address_line1?.trim() || null : null,
    billing_address_line2: on ? values.billing_address_line2?.trim() || null : null,
    billing_sub_district: on ? values.billing_sub_district?.trim() || null : null,
    billing_city: on ? values.billing_city?.trim() || null : null,
    billing_province: on ? values.billing_province?.trim() || null : null,
    billing_postal_code: on ? values.billing_postal_code?.trim() || null : null,
    billing_country: on
      ? values.billing_country?.trim().toUpperCase() || null
      : null,
  };
}

export type EditablePrimaryContact = {
  readonly contactId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly roleTitle: string | null;
  readonly preferredLanguage: 'en' | 'th' | 'sv';
  // Thai Alumni DOB — 'YYYY-MM-DD' or null. Seeded from the member's stored
  // value so the edit form shows the present DOB (was omitted entirely, so the
  // field loaded blank AND any typed value was dropped by the builders below).
  readonly dateOfBirth: string | null;
};

/** Member-company field PATCH body (always full — diff is tracked by the use case). */
export function buildFieldPayload(
  values: MemberFormValues,
): Record<string, unknown> {
  return {
    company_name: values.company_name.trim(),
    legal_entity_type: values.legal_entity_type?.trim() || null,
    country: values.country.toUpperCase(),
    tax_id: values.tax_id?.trim() || null,
    website: values.website?.trim() || null,
    description: values.description?.trim() || null,
    address_line1: values.address_line1?.trim() || null,
    address_line2: values.address_line2?.trim() || null,
    city: values.city?.trim() || null,
    province: values.province?.trim() || null,
    postal_code: values.postal_code?.trim() || null,
    // PR-B task 6 — แขวง/ตำบล.
    sub_district: values.sub_district?.trim() || null,
    // `values.notes` is already `string | null` after the form's zod
    // transform. Safe to trim only when string.
    notes: values.notes ? values.notes.trim() || null : null,
    founded_year:
      typeof values.founded_year === 'number' ? values.founded_year : null,
    turnover_thb:
      typeof values.turnover_thb === 'number' ? values.turnover_thb : null,
    // PR-B task 7 — ทุนจดทะเบียน. A separate field from turnover_thb above.
    registered_capital_thb:
      typeof values.registered_capital_thb === 'number'
        ? values.registered_capital_thb
        : null,
    // 088 US3 — §86/4 branch particular. Always send a CHECK-consistent pair:
    // head office ⇒ branch_code null; branch ⇒ the trimmed 5-digit code (the
    // form's zod already validated the digit count + registrant rule).
    is_head_office: values.is_head_office ?? true,
    branch_code: (values.is_head_office ?? true)
      ? null
      : values.branch_code?.trim() || null,
    // 059 / PR-A — the RECORDED §86/4 discriminator. Sent on every field PATCH
    // so an admin ticking ONLY this box still persists (see hasFieldDiff).
    is_vat_registered: values.is_vat_registered ?? false,
    // 065 §5.1 — per-member billing cadence. Sent on every field PATCH (the
    // client zod requires a pick, so `values.billing_cycle` is always set;
    // `?? 'rolling'` mirrors is_vat_registered's `?? false` default-normalise).
    billing_cycle: values.billing_cycle ?? 'rolling',
    // member-billing-address (0284) — the whole group rides every field
    // PATCH (all-null when the toggle is off, which clears it).
    ...buildBillingAddressPayload(values),
  };
}

/** True when any member-company field differs from the persisted member. */
export function hasFieldDiff(
  values: MemberFormValues,
  member: MemberInitialValues,
): boolean {
  return (
    values.company_name.trim() !== member.companyName ||
    (values.country?.toUpperCase() ?? '') !== member.country ||
    (values.legal_entity_type?.trim() ?? null) !==
      (member.legalEntityType ?? null) ||
    (values.tax_id?.trim() ?? null) !== (member.taxId ?? null) ||
    (values.website?.trim() || null) !== (member.website ?? null) ||
    (values.address_line1?.trim() || null) !== (member.addressLine1 ?? null) ||
    (values.address_line2?.trim() || null) !== (member.addressLine2 ?? null) ||
    (values.city?.trim() || null) !== (member.city ?? null) ||
    (values.province?.trim() || null) !== (member.province ?? null) ||
    (values.postal_code?.trim() || null) !== (member.postalCode ?? null) ||
    (values.sub_district?.trim() || null) !== (member.subDistrict ?? null) ||
    (values.description?.trim() || null) !== (member.description ?? null) ||
    (values.notes ? values.notes.trim() || null : null) !==
      (member.notes ?? null) ||
    (typeof values.founded_year === 'number' ? values.founded_year : null) !==
      (member.foundedYear ?? null) ||
    (typeof values.turnover_thb === 'number' ? values.turnover_thb : null) !==
      (member.turnoverThb ?? null) ||
    (typeof values.registered_capital_thb === 'number'
      ? values.registered_capital_thb
      : null) !== (member.registeredCapitalThb ?? null) ||
    // 088 US3 — §86/4 branch particular (both sides default head-office / null).
    (values.is_head_office ?? true) !== (member.isHeadOffice ?? true) ||
    ((values.is_head_office ?? true)
      ? null
      : values.branch_code?.trim() || null) !== (member.branchCode ?? null) ||
    // 059 / PR-A — without this leg, ticking ONLY the VAT box produces no diff,
    // so no PATCH fires and the flag silently fails to save.
    (values.is_vat_registered ?? false) !== (member.isVatRegistered ?? false) ||
    // 065 §5.1 — without this leg, changing ONLY the billing cycle produces no
    // diff, so no PATCH fires and the change silently fails to save. Both sides
    // normalise to 'rolling' so a fixture omitting either does not false-trigger.
    (values.billing_cycle ?? 'rolling') !== (member.billingCycle ?? 'rolling') ||
    // member-billing-address (0284) — without these legs, editing (or
    // clearing via the toggle) ONLY the billing group produces no diff → no
    // PATCH → silent no-save. Compares the PAYLOAD-normalised group (toggle
    // off ⇒ all-null) against the persisted values.
    billingAddressChanged(values, member)
  );
}

/** True when the (toggle-normalised) billing group differs from the member. */
export function billingAddressChanged(
  values: MemberFormValues,
  member: MemberInitialValues,
): boolean {
  const p = buildBillingAddressPayload(values);
  return (
    p.billing_address_line1 !== (member.billingAddressLine1 ?? null) ||
    p.billing_address_line2 !== (member.billingAddressLine2 ?? null) ||
    p.billing_sub_district !== (member.billingSubDistrict ?? null) ||
    p.billing_city !== (member.billingCity ?? null) ||
    p.billing_province !== (member.billingProvince ?? null) ||
    p.billing_postal_code !== (member.billingPostalCode ?? null) ||
    p.billing_country !== (member.billingCountry ?? null)
  );
}

/**
 * Non-email primary-contact patch — only the fields that actually changed.
 * Sending the full set would needlessly re-validate untouched fields
 * server-side (e.g. editing just the role would re-run the strict E.164
 * phone check on the unchanged phone).
 */
export function buildContactPayload(
  values: MemberFormValues,
  contact: EditablePrimaryContact,
): Record<string, unknown> {
  const c = values.primary_contact;
  const body: Record<string, unknown> = {};
  if (c.first_name.trim() !== contact.firstName)
    body.first_name = c.first_name.trim();
  if (c.last_name.trim() !== contact.lastName)
    body.last_name = c.last_name.trim();
  if ((c.phone?.trim() || null) !== (contact.phone ?? null))
    body.phone = c.phone?.trim() || null;
  if ((c.role_title?.trim() || null) !== (contact.roleTitle ?? null))
    body.role_title = c.role_title?.trim() || null;
  if (c.preferred_language !== contact.preferredLanguage)
    body.preferred_language = c.preferred_language;
  // Thai Alumni DOB — send only when changed (empty ⇒ null clears it). The
  // server's updateContactFieldsSchema now accepts `date_of_birth`.
  if ((c.date_of_birth?.trim() || null) !== (contact.dateOfBirth ?? null))
    body.date_of_birth = c.date_of_birth?.trim() || null;
  return body;
}

/** True when any non-email primary-contact field changed. */
export function contactFieldsChanged(
  values: MemberFormValues,
  contact: EditablePrimaryContact,
): boolean {
  const c = values.primary_contact;
  return (
    c.first_name.trim() !== contact.firstName ||
    c.last_name.trim() !== contact.lastName ||
    (c.phone?.trim() || null) !== (contact.phone ?? null) ||
    (c.role_title?.trim() || null) !== (contact.roleTitle ?? null) ||
    c.preferred_language !== contact.preferredLanguage ||
    // Thai Alumni DOB — without this leg a DOB-only edit produces no diff, so
    // no contact PATCH fires and the new/changed birthdate silently fails to save.
    (c.date_of_birth?.trim() || null) !== (contact.dateOfBirth ?? null)
  );
}

/** True when the primary-contact email changed (constrained server-side). */
export function contactEmailChanged(
  values: MemberFormValues,
  contact: EditablePrimaryContact,
): boolean {
  return values.primary_contact.email.trim() !== contact.email;
}

/** True when the plan id or plan year changed. */
export function planChanged(
  values: MemberFormValues,
  member: MemberInitialValues,
): boolean {
  return (
    values.plan_id !== member.planId || values.plan_year !== member.planYear
  );
}
