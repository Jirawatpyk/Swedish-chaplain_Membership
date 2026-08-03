/**
 * member-billing-address (0284) — CREATE-side validation of the optional
 * tax-document billing-address group.
 *
 * Unlike update (a partial patch — see update-member-billing-address.test.ts),
 * create sees the WHOLE group at once, so the all-or-nothing rule lives in
 * the use-case body's up-front validation (step 2, BEFORE any dep is
 * touched): any field present ⇒ line1 + city + postal_code + country
 * required, and billing_country goes through the SAME asIsoCountryCode
 * validator as the company country. Because rejection happens before any
 * repo/audit call, the failing paths run with empty deps — no live DB, no
 * mocks to drift. The accepting roundtrip (values persisted + readable) is
 * live-Neon-proven in tests/integration/members/member-billing-address.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  createMember,
  createMemberSchema,
  type CreateMemberDeps,
} from '@/modules/members/application/use-cases/create-member';

const meta = { actorUserId: 'actor-uuid', requestId: 'req-billing-create' };
// The billing group is rejected BEFORE any dep is used (step-2 validation).
const noDeps = {} as CreateMemberDeps;

const baseInput = {
  company_name: 'ACME Co., Ltd.',
  country: 'TH',
  plan_id: 'plan-corporate',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Somchai',
    last_name: 'Jaidee',
    email: 'somchai@acme.example',
    preferred_language: 'en' as const,
  },
};

const FULL_GROUP = {
  billing_address_line1: '9 Tax Rd',
  billing_city: 'Bangkok',
  billing_postal_code: '10500',
  billing_country: 'TH',
};

describe('createMemberSchema — billing address field shapes (0284)', () => {
  it('accepts the full group and preserves the values', () => {
    const parsed = createMemberSchema.parse({ ...baseInput, ...FULL_GROUP });
    expect(parsed.billing_address_line1).toBe('9 Tax Rd');
    expect(parsed.billing_country).toBe('TH');
  });

  it('accepts the group entirely omitted — the common case', () => {
    const parsed = createMemberSchema.parse(baseInput);
    expect(parsed.billing_address_line1).toBeUndefined();
  });

  it('rejects an over-long billing_address_line1 (max 200)', () => {
    expect(
      createMemberSchema.safeParse({
        ...baseInput,
        ...FULL_GROUP,
        billing_address_line1: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });

  it('rejects a billing_country that is not exactly 2 chars', () => {
    expect(
      createMemberSchema.safeParse({
        ...baseInput,
        ...FULL_GROUP,
        billing_country: 'THA',
      }).success,
    ).toBe(false);
  });
});

describe('createMember body — all-or-nothing billing group (0284)', () => {
  it('rejects a partial group (city only) with billing_address_incomplete', async () => {
    const result = await createMember(
      { ...baseInput, billing_city: 'Bangkok' },
      meta,
      noDeps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('billing_address_incomplete');
    }
  });

  it('rejects an OPTIONAL field alone (province enables the group)', async () => {
    const result = await createMember(
      { ...baseInput, billing_province: 'Bangkok' },
      meta,
      noDeps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('billing_address_incomplete');
    }
  });

  it('rejects a group missing only the country', async () => {
    const { billing_country: _omit, ...withoutCountry } = FULL_GROUP;
    const result = await createMember(
      { ...baseInput, ...withoutCountry },
      meta,
      noDeps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('billing_address_incomplete');
    }
  });

  it('rejects a well-formed but non-existent billing country (ZZ) via the shared ISO validator', async () => {
    const result = await createMember(
      { ...baseInput, ...FULL_GROUP, billing_country: 'ZZ' },
      meta,
      noDeps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_country');
    }
  });

  it('explicit all-null group is treated as absent (no billing_address_incomplete)', async () => {
    // Proves all-null ≠ partial: the flow must sail PAST the billing check
    // and reach the plan lookup (the first dep the happy path touches),
    // where a stubbed getPlan stops it with plan_not_found.
    const planStopDeps = {
      plans: {
        getPlan: async () => ({ ok: false as const, error: { code: 'x' } }),
      },
    } as unknown as CreateMemberDeps;
    const result = await createMember(
      {
        ...baseInput,
        billing_address_line1: null,
        billing_address_line2: null,
        billing_sub_district: null,
        billing_city: null,
        billing_province: null,
        billing_postal_code: null,
        billing_country: null,
      },
      meta,
      planStopDeps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('plan_not_found');
    }
  });
});
