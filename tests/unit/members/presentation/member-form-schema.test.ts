/**
 * buildMemberFormSchema superRefine wiring (UAT 2026-06-30 fix, round-2 review
 * Gap-A). The domain validators (Thai Mod-11 checksum, ISO-3166) are unit-tested
 * in isolation; this pins the SCHEMA GLUE that the form depends on — the
 * `country === 'TH'` gate that scopes the checksum, the well-formed-shape guard,
 * the `.email()` rule, and that each issue lands on the correct field path.
 */
import { describe, expect, it } from 'vitest';
import type { Translator } from '@/lib/zod-i18n';
import { buildMemberFormSchema } from '@/components/members/member-form';

const tf = (k: string) => k;
const tv = ((k: string) => k) as unknown as Translator;
const schema = buildMemberFormSchema(tf, tv);

// PR-B task 6 — `buildMemberFormSchema` defaults `mode` to 'create' (a
// forgotten 4th arg fails SAFE, over-blocking rather than silently
// disabling the address-completeness gate a §86/4 tax invoice depends on).
// BASE therefore needs a COMPLETE TH address or every "accepts" assertion
// below would start failing on address_line1/city/province/sub_district/
// postal_code — those fields are not what this file is testing.
const BASE = {
  company_name: 'Acme',
  country: 'TH',
  address_line1: '123 Sukhumvit Rd',
  sub_district: 'คลองตันเหนือ',
  city: 'เขตวัฒนา',
  province: 'กรุงเทพมหานคร',
  postal_code: '10110',
  plan_id: 'p',
  plan_year: 2026,
  notes: null,
  primary_contact: {
    first_name: 'A',
    last_name: 'B',
    email: 'a@b.com',
    preferred_language: 'en',
  },
};

/** Dot-joined paths of every zod issue (empty array ⇒ valid). */
function issuePaths(values: unknown): string[] {
  const r = schema.safeParse(values);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
}

describe('buildMemberFormSchema — client mirrors server', () => {
  it('accepts the base valid object', () => {
    expect(issuePaths(BASE)).toEqual([]);
  });

  it('accepts a valid TH tax-id (correct Mod-11 check digit)', () => {
    expect(issuePaths({ ...BASE, tax_id: '0105556012341' })).toEqual([]);
  });

  it('rejects a bad TH tax-id checksum on the tax_id field', () => {
    expect(issuePaths({ ...BASE, tax_id: '0105556012345' })).toContain('tax_id');
  });

  it('does NOT checksum a non-TH tax-id (length-only on the server)', () => {
    // Same digits that fail the TH checksum, but country=SE ⇒ no checksum.
    expect(
      issuePaths({ ...BASE, country: 'SE', tax_id: '0105556012345' }),
    ).not.toContain('tax_id');
  });

  it('rejects a well-formed but non-existent country code on the country field', () => {
    expect(issuePaths({ ...BASE, country: 'ZZ' })).toContain('country');
  });

  it('accepts a real ISO-3166 alpha-2 country', () => {
    expect(issuePaths({ ...BASE, country: 'SE' })).toEqual([]);
  });

  it('rejects a malformed email on the contact email field', () => {
    expect(
      issuePaths({
        ...BASE,
        primary_contact: { ...BASE.primary_contact, email: 'notanemail' },
      }),
    ).toContain('primary_contact.email');
  });

  it('does NOT require DOB by default (2-arg schema)', () => {
    expect(issuePaths(BASE)).not.toContain('primary_contact.date_of_birth');
  });

  it('rejects a founded_year outside 1800..thisYear on the founded_year field', () => {
    expect(issuePaths({ ...BASE, founded_year: '1500' })).toContain('founded_year');
    expect(issuePaths({ ...BASE, founded_year: '3000' })).toContain('founded_year');
  });

  it('accepts a valid founded_year', () => {
    expect(issuePaths({ ...BASE, founded_year: '1990' })).not.toContain('founded_year');
  });

  it('rejects a negative turnover on the turnover_thb field', () => {
    expect(issuePaths({ ...BASE, turnover_thb: '-5' })).toContain('turnover_thb');
  });
});

// PR-B task 7 — registered_capital_thb is a SEPARATE field from turnover_thb
// (a reviewer asked for a rename; not done — turnover gates the F2 plan
// turnover band + F8 tier upgrades). Mirrors turnover_thb's own rule exactly.
describe('buildMemberFormSchema — registered_capital_thb (PR-B task 7)', () => {
  it('rejects a negative registered capital on its own field', () => {
    expect(issuePaths({ ...BASE, registered_capital_thb: '-5' })).toContain(
      'registered_capital_thb',
    );
  });

  it('accepts a valid registered capital, independent of turnover_thb', () => {
    expect(
      issuePaths({
        ...BASE,
        registered_capital_thb: '5000000',
        turnover_thb: '1000000',
      }),
    ).toEqual([]);
  });

  it('is optional — omitting it entirely is valid', () => {
    expect(issuePaths(BASE)).not.toContain('registered_capital_thb');
  });
});

// PR-B task 7 — website accepts a bare domain by prefixing https:// BEFORE
// the .url() check runs (z.preprocess). `example.com` alone would fail
// `.url()` outright, and a Facebook page slug is the single most common
// thing an admin pastes here.
describe('buildMemberFormSchema — website accepts a bare domain (PR-B task 7)', () => {
  it('normalizes a bare domain by prefixing https://', () => {
    const r = schema.safeParse({ ...BASE, website: 'example.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.website).toBe('https://example.com');
  });

  it('normalizes a bare Facebook page slug', () => {
    const r = schema.safeParse({ ...BASE, website: 'facebook.com/swecham' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.website).toBe('https://facebook.com/swecham');
  });

  it('leaves an already-complete https:// URL unchanged', () => {
    const r = schema.safeParse({ ...BASE, website: 'https://facebook.com/x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.website).toBe('https://facebook.com/x');
  });

  it('leaves an already-complete http:// URL unchanged (does not force https)', () => {
    const r = schema.safeParse({ ...BASE, website: 'http://example.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.website).toBe('http://example.com');
  });

  it('still rejects a non-URL string on the website field', () => {
    expect(issuePaths({ ...BASE, website: 'not a url' })).toContain('website');
  });

  it('still accepts an empty website (optional field)', () => {
    expect(issuePaths({ ...BASE, website: '' })).not.toContain('website');
  });
});

describe('buildMemberFormSchema — conditional DOB requirement (requireDob=true)', () => {
  const dobSchema = buildMemberFormSchema(tf, tv, true);
  function dobPaths(values: unknown): string[] {
    const r = dobSchema.safeParse(values);
    return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
  }

  it('flags an empty DOB on the primary_contact.date_of_birth path', () => {
    expect(dobPaths(BASE)).toContain('primary_contact.date_of_birth');
  });

  it('accepts when a DOB is provided', () => {
    expect(
      dobPaths({
        ...BASE,
        primary_contact: { ...BASE.primary_contact, date_of_birth: '1990-05-01' },
      }),
    ).not.toContain('primary_contact.date_of_birth');
  });
});

// 088 US3 (FR-008) — branch pairing + registrant cross-field rules. US3-review
// finding: these were wired in the form (member-form.tsx superRefine) but had
// ZERO coverage — a regression weakening the /^\d{5}$/ regex or dropping the
// individual guard would have passed the whole suite undetected.
describe('buildMemberFormSchema — branch cross-field rules (088 US3 / FR-008)', () => {
  it('accepts a head office (is_head_office=true, no branch_code)', () => {
    expect(issuePaths({ ...BASE, is_head_office: true })).toEqual([]);
  });

  it('flags a non-5-digit branch_code on the branch_code field (branchCodeFormat)', () => {
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '123',
        legal_entity_type: 'company',
      }),
    ).toContain('branch_code');
  });

  it('flags a branch on a non-registrant — individual in ANY casing (branchOnNonRegistrant)', () => {
    // Shares the same normalizer the adapter fail-open was fixed with, so the
    // capital-I variant that broke the §86/4 render is caught at the form too.
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        legal_entity_type: 'Individual',
      }),
    ).toContain('branch_code');
  });

  it('flags a branch on an empty legal_entity_type (branchOnNonRegistrant)', () => {
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        legal_entity_type: '',
      }),
    ).toContain('branch_code');
  });

  it('accepts a valid branch (is_head_office=false + 5-digit code + juristic type)', () => {
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        legal_entity_type: 'company',
      }),
    ).toEqual([]);
  });
});

// PR-B task 6 — address completeness gate. CREATE blocks; EDIT never does
// (an admin fixing an unrelated field on an imported member with no address
// must not be locked out — the same trap PR-0 avoided for
// `registration_date`). `mode` defaults to 'create', so most cases below
// pass it explicitly only where the point is to contrast with 'edit'.
describe('buildMemberFormSchema — address completeness gate (PR-B task 6)', () => {
  it('create + TH: flags a missing sub_district', () => {
    const { sub_district: _omit, ...rest } = BASE;
    expect(issuePaths(rest)).toContain('sub_district');
  });

  it('create + TH: flags a missing province', () => {
    const { province: _omit, ...rest } = BASE;
    expect(issuePaths(rest)).toContain('province');
  });

  it('create + TH: flags a missing postal_code', () => {
    const { postal_code: _omit, ...rest } = BASE;
    expect(issuePaths(rest)).toContain('postal_code');
  });

  it('create + TH: flags a missing address_line1', () => {
    const { address_line1: _omit, ...rest } = BASE;
    expect(issuePaths(rest)).toContain('address_line1');
  });

  it('create + TH: flags a missing city', () => {
    const { city: _omit, ...rest } = BASE;
    expect(issuePaths(rest)).toContain('city');
  });

  it('create + non-TH: requires only address_line1 + city — province/sub_district/postal_code stay optional', () => {
    expect(
      issuePaths({
        ...BASE,
        country: 'SE',
        province: undefined,
        sub_district: undefined,
        postal_code: undefined,
      }),
    ).toEqual([]);
  });

  it('create + non-TH: still flags a missing city', () => {
    expect(
      issuePaths({
        ...BASE,
        country: 'SE',
        city: undefined,
        province: undefined,
        sub_district: undefined,
        postal_code: undefined,
      }),
    ).toContain('city');
  });

  it('edit: never blocks on a completely empty address', () => {
    const editSchema = buildMemberFormSchema(tf, tv, false, 'edit');
    const editPaths = (values: unknown): string[] => {
      const r = editSchema.safeParse(values);
      return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
    };
    expect(
      editPaths({
        ...BASE,
        address_line1: undefined,
        sub_district: undefined,
        city: undefined,
        province: undefined,
        postal_code: undefined,
      }),
    ).toEqual([]);
  });
});
