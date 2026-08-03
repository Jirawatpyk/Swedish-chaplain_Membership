/**
 * Unit: edit-member payload builders + change detectors.
 *
 * Guards the session's headline fix (primary-contact edits were dropped)
 * at the decision-logic level: contactFieldsChanged / buildContactPayload
 * decide whether — and what — the contact PATCH sends. Also pins the
 * `''`-vs-`null` trim normalisation that, if wrong, silently drops a field
 * or fires a no-op PATCH.
 */
import { describe, expect, it } from 'vitest';
import type { MemberFormValues } from '@/components/members/member-form';
import {
  buildFieldPayload,
  buildContactPayload,
  buildBillingAddressPayload,
  billingAddressChanged,
  hasFieldDiff,
  contactFieldsChanged,
  contactEmailChanged,
  planChanged,
  type MemberInitialValues,
  type EditablePrimaryContact,
} from '@/components/members/edit-member-payloads';

const member: MemberInitialValues = {
  memberId: 'm',
  companyName: 'Acme',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  notes: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  province: null,
  postalCode: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'premium',
  planYear: 2026,
  registrationDate: '2026-01-01',
};

const contact: EditablePrimaryContact = {
  contactId: 'c',
  firstName: 'Alice',
  lastName: 'A',
  email: 'alice@example.com',
  phone: null,
  roleTitle: 'Manager',
  preferredLanguage: 'en',
  dateOfBirth: null,
};

type ContactValues = MemberFormValues['primary_contact'];

function makeValues(
  o: Partial<MemberFormValues> = {},
  co: Partial<ContactValues> = {},
): MemberFormValues {
  return {
    company_name: 'Acme',
    legal_entity_type: undefined,
    country: 'TH',
    tax_id: undefined,
    website: undefined,
    description: undefined,
    address_line1: undefined,
    address_line2: undefined,
    city: undefined,
    province: undefined,
    postal_code: undefined,
    founded_year: undefined,
    turnover_thb: undefined,
    plan_id: 'premium',
    plan_year: 2026,
    // 065 §5.1 — billing_cycle is a required MemberFormValues field.
    billing_cycle: 'rolling',
    registration_date: '2026-01-01',
    notes: null,
    primary_contact: {
      first_name: 'Alice',
      last_name: 'A',
      email: 'alice@example.com',
      phone: undefined,
      role_title: 'Manager',
      preferred_language: 'en',
      date_of_birth: undefined,
      ...co,
    },
    ...o,
  } as MemberFormValues;
}

describe('change detection — baseline (form seeded from current values)', () => {
  it('no member-field diff when nothing changed', () => {
    expect(hasFieldDiff(makeValues(), member)).toBe(false);
  });
  it('no contact-field change when nothing changed', () => {
    expect(contactFieldsChanged(makeValues(), contact)).toBe(false);
  });
  it('no contact-email change when nothing changed', () => {
    expect(contactEmailChanged(makeValues(), contact)).toBe(false);
  });
  it('no plan change when nothing changed', () => {
    expect(planChanged(makeValues(), member)).toBe(false);
  });
});

describe('contactFieldsChanged', () => {
  it('detects a role change', () => {
    expect(
      contactFieldsChanged(makeValues({}, { role_title: 'Director' }), contact),
    ).toBe(true);
  });
  it('detects an added phone', () => {
    expect(
      contactFieldsChanged(makeValues({}, { phone: '+66812345678' }), contact),
    ).toBe(true);
  });
  it('does NOT treat whitespace-only phone as a change (null ↔ "  ")', () => {
    expect(contactFieldsChanged(makeValues({}, { phone: '   ' }), contact)).toBe(
      false,
    );
  });
  it('detects a cleared role (Manager → empty)', () => {
    expect(
      contactFieldsChanged(makeValues({}, { role_title: '' }), contact),
    ).toBe(true);
  });
  it('detects a preferred-language change', () => {
    expect(
      contactFieldsChanged(makeValues({}, { preferred_language: 'th' }), contact),
    ).toBe(true);
  });
  // Thai Alumni DOB — a DOB-only edit must fire the contact PATCH; without the
  // DOB leg in contactFieldsChanged the birthdate silently never saved.
  it('detects an added date_of_birth (null → value)', () => {
    expect(
      contactFieldsChanged(makeValues({}, { date_of_birth: '2000-01-15' }), contact),
    ).toBe(true);
  });
  it('detects a changed date_of_birth', () => {
    expect(
      contactFieldsChanged(
        makeValues({}, { date_of_birth: '1999-12-31' }),
        { ...contact, dateOfBirth: '2000-01-15' },
      ),
    ).toBe(true);
  });
  it('does NOT treat unchanged date_of_birth as a change', () => {
    expect(
      contactFieldsChanged(
        makeValues({}, { date_of_birth: '2000-01-15' }),
        { ...contact, dateOfBirth: '2000-01-15' },
      ),
    ).toBe(false);
  });
});

describe('buildContactPayload — only changed fields', () => {
  it('role-only edit sends just role_title', () => {
    expect(
      buildContactPayload(makeValues({}, { role_title: 'Director' }), contact),
    ).toEqual({ role_title: 'Director' });
  });
  it('cleared role sends role_title: null', () => {
    expect(
      buildContactPayload(makeValues({}, { role_title: '  ' }), contact),
    ).toEqual({ role_title: null });
  });
  it('added phone is trimmed and sent', () => {
    expect(
      buildContactPayload(makeValues({}, { phone: ' +66812345678 ' }), contact),
    ).toEqual({ phone: '+66812345678' });
  });
  it('name change sends trimmed first/last only', () => {
    expect(
      buildContactPayload(
        makeValues({}, { first_name: '  Bob  ', last_name: 'A' }),
        contact,
      ),
    ).toEqual({ first_name: 'Bob' });
  });
  it('no change → empty patch', () => {
    expect(buildContactPayload(makeValues(), contact)).toEqual({});
  });
});

describe('contactEmailChanged', () => {
  it('trims before comparing (no spurious change)', () => {
    expect(
      contactEmailChanged(makeValues({}, { email: '  alice@example.com ' }), contact),
    ).toBe(false);
  });
  it('detects a real email change', () => {
    expect(
      contactEmailChanged(makeValues({}, { email: 'new@example.com' }), contact),
    ).toBe(true);
  });
});

describe('hasFieldDiff', () => {
  it('detects a company-name change', () => {
    expect(hasFieldDiff(makeValues({ company_name: 'Acme Renamed' }), member)).toBe(
      true,
    );
  });
  // PR-0 finding 4: a changed registration_date must NOT trip hasFieldDiff —
  // paired with the buildFieldPayload guard above so the two stay in sync.
  it('a changed registration_date does not trip hasFieldDiff', () => {
    expect(
      hasFieldDiff(makeValues({ registration_date: '2025-06-15' }), member),
    ).toBe(false);
  });
  it('detects an added address field', () => {
    expect(hasFieldDiff(makeValues({ city: 'Bangkok' }), member)).toBe(true);
  });
  // PR-B task 6 — แขวง/ตำบล. `member.subDistrict` is optional (undefined
  // on the fixture above), so this also pins the `?? null` fallback on
  // BOTH sides of the comparison.
  it('detects an added sub_district', () => {
    expect(
      hasFieldDiff(makeValues({ sub_district: 'คลองตันเหนือ' }), member),
    ).toBe(true);
  });
  it('does NOT treat "" vs null as a change (website blank)', () => {
    expect(hasFieldDiff(makeValues({ website: '' }), member)).toBe(false);
  });
  it('detects a turnover change', () => {
    expect(hasFieldDiff(makeValues({ turnover_thb: 5_000_000 }), member)).toBe(
      true,
    );
  });
});

describe('buildFieldPayload', () => {
  it('trims address parts and maps empty → null', () => {
    const out = buildFieldPayload(
      makeValues({ address_line1: '  99 Rd  ', city: '' }),
    );
    expect(out.address_line1).toBe('99 Rd');
    expect(out.city).toBeNull();
  });

  // PR-B task 6 — แขวง/ตำบล follows the same trim + empty→null shape as
  // every other address part.
  it('trims sub_district and maps empty → null', () => {
    const out = buildFieldPayload(makeValues({ sub_district: '  คลองตันเหนือ  ' }));
    expect(out.sub_district).toBe('คลองตันเหนือ');
    expect(buildFieldPayload(makeValues({ sub_district: '' })).sub_district).toBeNull();
  });

  // PR-0 finding 4: registration_date is read-only in edit mode (Task 2)
  // ONLY because this function never emits it and updateMemberSchema is
  // `.strict()` without the key — sending it 400s. If a future change adds
  // registration_date to hasFieldDiff without adding it to the schema,
  // every edit save breaks silently. Guard both halves of that invariant.
  it('never emits a registration_date key, even when the form carries one', () => {
    const out = buildFieldPayload(
      makeValues({ registration_date: '2025-06-15' }),
    );
    expect(out).not.toHaveProperty('registration_date');
  });
});

describe('planChanged', () => {
  it('detects a plan id change', () => {
    expect(planChanged(makeValues({ plan_id: 'diamond' }), member)).toBe(true);
  });
  it('detects a plan year change', () => {
    expect(planChanged(makeValues({ plan_year: 2027 }), member)).toBe(true);
  });
});

// member-billing-address (0284) — the group's ''-vs-null normalisation +
// toggle semantics. Shared by create + edit, so a bug here silently drops
// (or spuriously clears) the ภ.พ.20 address on BOTH flows.
describe('buildBillingAddressPayload (0284)', () => {
  const ON = {
    billing_differs: true,
    billing_address_line1: ' 9 Tax Rd ',
    billing_address_line2: '',
    billing_sub_district: undefined,
    billing_city: ' Bangkok ',
    billing_province: '  ',
    billing_postal_code: '10500',
    billing_country: ' th ',
  } as Partial<MemberFormValues>;

  it('toggle ON → trims, maps empty → null, uppercases country', () => {
    expect(buildBillingAddressPayload(makeValues(ON))).toEqual({
      billing_address_line1: '9 Tax Rd',
      billing_address_line2: null,
      billing_sub_district: null,
      billing_city: 'Bangkok',
      billing_province: null,
      billing_postal_code: '10500',
      billing_country: 'TH',
    });
  });

  it('toggle OFF → every field null even when values linger in form state', () => {
    // Unchecking HIDES the group but keeps typed values in RHF state — the
    // payload must still clear the whole group server-side.
    expect(
      buildBillingAddressPayload(makeValues({ ...ON, billing_differs: false })),
    ).toEqual({
      billing_address_line1: null,
      billing_address_line2: null,
      billing_sub_district: null,
      billing_city: null,
      billing_province: null,
      billing_postal_code: null,
      billing_country: null,
    });
  });

  it('toggle absent (create form untouched) behaves as OFF', () => {
    expect(
      buildBillingAddressPayload(makeValues()).billing_address_line1,
    ).toBeNull();
  });

  it('buildFieldPayload carries the group (all-null when off)', () => {
    const out = buildFieldPayload(makeValues());
    expect(out.billing_address_line1).toBeNull();
    expect(out.billing_country).toBeNull();
  });
});

describe('billingAddressChanged / hasFieldDiff billing legs (0284)', () => {
  const memberWithBilling: MemberInitialValues = {
    ...member,
    billingAddressLine1: '9 Tax Rd',
    billingAddressLine2: null,
    billingSubDistrict: null,
    billingCity: 'Bangkok',
    billingProvince: null,
    billingPostalCode: '10500',
    billingCountry: 'TH',
  };
  const formOnSame = {
    billing_differs: true,
    billing_address_line1: '9 Tax Rd',
    billing_city: 'Bangkok',
    billing_postal_code: '10500',
    billing_country: 'TH',
  } as Partial<MemberFormValues>;

  it('no change when toggle ON mirrors the persisted group', () => {
    expect(billingAddressChanged(makeValues(formOnSame), memberWithBilling)).toBe(
      false,
    );
    expect(hasFieldDiff(makeValues(formOnSame), memberWithBilling)).toBe(false);
  });

  it('no change when toggle OFF and member has no billing address', () => {
    expect(billingAddressChanged(makeValues(), member)).toBe(false);
  });

  it('detects ADDING a billing address (fires the PATCH)', () => {
    expect(billingAddressChanged(makeValues(formOnSame), member)).toBe(true);
    expect(hasFieldDiff(makeValues(formOnSame), member)).toBe(true);
  });

  it('detects CLEARING via the toggle (member has one, toggle now off)', () => {
    // Without this leg, unchecking the toggle produced no diff → no PATCH →
    // the billing address silently survived on the member.
    expect(
      billingAddressChanged(
        makeValues({ ...formOnSame, billing_differs: false }),
        memberWithBilling,
      ),
    ).toBe(true);
    expect(
      hasFieldDiff(
        makeValues({ ...formOnSame, billing_differs: false }),
        memberWithBilling,
      ),
    ).toBe(true);
  });

  it('detects a single-field edit inside the group', () => {
    expect(
      billingAddressChanged(
        makeValues({ ...formOnSame, billing_postal_code: '10110' }),
        memberWithBilling,
      ),
    ).toBe(true);
  });

  it('fixture omitting the optional billing keys compares as all-null', () => {
    // `member` (no billing keys at all) must behave exactly like explicit
    // nulls — pins the `?? null` on the MemberInitialValues side.
    expect(billingAddressChanged(makeValues(), member)).toBe(false);
  });
});
