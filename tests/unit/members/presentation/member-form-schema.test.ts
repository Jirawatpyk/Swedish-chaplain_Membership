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
import { LEGAL_ENTITY_TYPES } from '@/modules/members';

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
  // 065 §5.1 — billing_cycle is a REQUIRED free choice (no default / no '' arm),
  // so every otherwise-valid fixture must carry one or the whole object rejects.
  billing_cycle: 'rolling',
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

  // Review fix (Task 7): `turnover_thb` is a `bigint` column (no decimals).
  // The client rule used to be `Number.isFinite`, which let a fractional
  // value like "1.5" pass the client and reach the server's
  // `z.number().int()`, producing a 400 `invalid_body` that
  // `mapMemberCreateServerError` has no case for — a generic toast with
  // nothing highlighted. Reject it inline instead.
  it('rejects a non-integer turnover on the turnover_thb field', () => {
    expect(issuePaths({ ...BASE, turnover_thb: '1.5' })).toContain('turnover_thb');
  });
});

// 065 §5.1 — billing_cycle is a REQUIRED free choice: no default and (unlike
// legal_entity_type) no empty-string arm, so an unset value must fail on its
// own field, and only the two enum values are accepted.
describe('buildMemberFormSchema — billing_cycle is a required free choice (065 §5.1)', () => {
  it('flags a missing billing_cycle on its own field', () => {
    const { billing_cycle: _omitted, ...withoutCycle } = BASE;
    expect(issuePaths(withoutCycle)).toContain('billing_cycle');
  });

  it('rejects an empty-string billing_cycle (no empty arm) on its own field', () => {
    expect(issuePaths({ ...BASE, billing_cycle: '' })).toContain('billing_cycle');
  });

  it('rejects an unknown billing_cycle value on its own field', () => {
    expect(issuePaths({ ...BASE, billing_cycle: 'quarterly' })).toContain('billing_cycle');
  });

  it('accepts calendar', () => {
    expect(issuePaths({ ...BASE, billing_cycle: 'calendar' })).not.toContain('billing_cycle');
  });

  it('accepts rolling', () => {
    expect(issuePaths({ ...BASE, billing_cycle: 'rolling' })).not.toContain('billing_cycle');
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

  // Review fix (Task 7) — same bigint-column reasoning as turnover_thb above.
  it('rejects a non-integer registered capital on its own field', () => {
    expect(issuePaths({ ...BASE, registered_capital_thb: '1.5' })).toContain(
      'registered_capital_thb',
    );
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
// registrant guard would have passed the whole suite undetected.
//
// 059 / PR-A Task 3 — the registrant half of the rule now reads the RECORDED
// `is_vat_registered` flag, the same fact the identity adapter pins onto the
// §86/4 snapshot at issue. It used to be GUESSED from `legal_entity_type`
// ("anything that is not 'individual'"), which is why the form and the document
// could disagree. `legal_entity_type` no longer participates in this rule at
// all — hence no more casing/whitespace cases.
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
        is_vat_registered: true,
      }),
    ).toContain('branch_code');
  });

  it('flags a branch on a non-registrant (branchOnNonRegistrant)', () => {
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        is_vat_registered: false,
      }),
    ).toContain('branch_code');
  });

  it('flags a branch when the registrant flag is UNSET — fail-closed', () => {
    // `is_vat_registered` is `.optional()` on the schema, so `undefined` is
    // reachable. It must NOT be treated as "probably a registrant".
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
      }),
    ).toContain('branch_code');
  });

  it('flags a branch on a JURISTIC entity that is not VAT-registered — the legal form does NOT decide', () => {
    // The regression guard for the deleted `isVatRegistrantEntityType` guess:
    // it returned TRUE for 'company' and would have accepted this branch, then
    // printed a §86/4 Head-Office line for a non-registrant. A company below the
    // §85/1 turnover threshold is an ordinary, real case.
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        legal_entity_type: 'company',
        is_vat_registered: false,
      }),
    ).toContain('branch_code');
  });

  it('accepts a valid branch (is_head_office=false + 5-digit code + recorded registrant)', () => {
    expect(
      issuePaths({
        ...BASE,
        is_head_office: false,
        branch_code: '00042',
        is_vat_registered: true,
        // 059 / PR-A Task 4 — a registrant now also requires a tax_id (see
        // the describe block below), so this "accepts" fixture needs one.
        tax_id: '0105556012341',
      }),
    ).toEqual([]);
  });
});

// 059 / PR-A Task 4 — registrant ⇒ TIN invariant (ประกาศอธิบดีฯ 196 + 199 are
// a PAIR): a member marked as VAT-registered must also carry a tax_id, or the
// §86/4 buyer block on a tax document would print the branch line with no
// taxpayer number. Mirrors the server-side create/update-member checks and
// the member-identity-snapshot Domain VO (the LAST, load-bearing gate).
describe('buildMemberFormSchema — registrant ⇒ TIN invariant (059 / PR-A Task 4)', () => {
  it('flags is_vat_registered:true with no tax_id on the tax_id field', () => {
    expect(
      issuePaths({ ...BASE, is_vat_registered: true }),
    ).toContain('tax_id');
  });

  it('flags is_vat_registered:true with a blank/whitespace-only tax_id', () => {
    expect(
      issuePaths({ ...BASE, is_vat_registered: true, tax_id: '   ' }),
    ).toContain('tax_id');
  });

  it('accepts is_vat_registered:true WITH a tax_id', () => {
    expect(
      issuePaths({
        ...BASE,
        is_vat_registered: true,
        tax_id: '0105556012341',
      }),
    ).not.toContain('tax_id');
  });

  it('accepts is_vat_registered:false with no tax_id — the common case', () => {
    expect(
      issuePaths({ ...BASE, is_vat_registered: false }),
    ).not.toContain('tax_id');
  });

  it('accepts is_vat_registered omitted entirely with no tax_id', () => {
    expect(issuePaths(BASE)).not.toContain('tax_id');
  });
});

// 059 / PR-A Task 3b — legal_entity_type closes to the 12-code catalogue.
// Task 1 shipped LEGAL_ENTITY_TYPES; nothing rendered it until this task —
// an admin could type ANY string, and the free-text `max(100)` rule
// happily accepted it. This pins the closed-enum replacement + the
// "genuinely accepts unset" requirement the brief calls out explicitly:
// 10 of TSCC's 150 members have no recorded type, and an edit to an
// unrelated field on one of them must never be blocked by this field.
describe('buildMemberFormSchema — legal_entity_type closed catalogue (PR-A Task 3b)', () => {
  it('accepts every code in the 12-entry catalogue', () => {
    for (const code of LEGAL_ENTITY_TYPES) {
      expect(issuePaths({ ...BASE, legal_entity_type: code })).not.toContain(
        'legal_entity_type',
      );
    }
  });

  it('rejects an out-of-catalogue string', () => {
    expect(
      issuePaths({ ...BASE, legal_entity_type: 'sole_proprietorship_ltd' }),
    ).toContain('legal_entity_type');
  });

  it('accepts the field omitted entirely (genuinely unset)', () => {
    expect(issuePaths(BASE)).not.toContain('legal_entity_type');
  });

  it('accepts an explicit empty string (the Select\'s "nothing picked" value)', () => {
    expect(issuePaths({ ...BASE, legal_entity_type: '' })).not.toContain(
      'legal_entity_type',
    );
  });

  // The importer (Task 7) writes `null` for a member with no recorded
  // type; edit-member-client.tsx maps that to `undefined` before it
  // reaches this schema. Pin the EDIT-mode path specifically: unset must
  // not block an otherwise-valid, unrelated edit.
  it('edit mode: a member with legal_entity_type unset does not block an unrelated edit', () => {
    const editSchema = buildMemberFormSchema(tf, tv, false, 'edit');
    const r = editSchema.safeParse({
      ...BASE,
      legal_entity_type: undefined,
      company_name: 'Renamed Co',
    });
    expect(r.success).toBe(true);
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

  // UAT 2026-07-15 — a non-TH member's address is FULLY optional (was:
  // address_line1 + city required). The §86/4 completeness gate is a THAI-buyer
  // requirement; many non-TH territories have no postal code / province concept,
  // so forcing any address field would block creating members from them.
  it('create + non-TH: address is fully optional — no field flagged', () => {
    expect(
      issuePaths({
        ...BASE,
        country: 'SE',
        address_line1: undefined,
        city: undefined,
        province: undefined,
        sub_district: undefined,
        postal_code: undefined,
      }),
    ).toEqual([]);
  });

  it('create + non-TH: does NOT flag a missing city', () => {
    expect(
      issuePaths({
        ...BASE,
        country: 'SE',
        city: undefined,
        province: undefined,
        sub_district: undefined,
        postal_code: undefined,
      }),
    ).not.toContain('city');
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

// Maintainer bug report (058-member-form-ux) — every EXISTING test above
// keeps `plan_id: 'p'` (a valid, non-empty string) from BASE. That never
// exercises the form's actual first-submit shape: `plan_id` is bound to a
// react-hook-form `Controller` (membership-section.tsx's `<Select>`) with NO
// entry in `useForm`'s `defaultValues` on a fresh CREATE — so on the very
// first submit of an empty form it is genuinely `undefined`, not `''`.
//
// Root cause: zod's `.superRefine()` compiles to a `ZodEffects` wrapper
// around the base `z.object({...})`. `ZodEffects._parse` only invokes the
// refinement callback when the INNER object's own parse status is NOT
// "aborted". A field failing a `.min()`/`.max()`/`.email()` check produces
// "dirty" (refinement continues), but a field whose VALUE doesn't match its
// declared TYPE at all (`z.string()` given `undefined`) produces
// "invalid_type" — which is "aborted", not "dirty" — and an aborted status
// on ANY key propagates to the whole object. The practical effect: with
// `plan_id` merely UNSET (not just empty), the ENTIRE superRefine block
// silently never runs — swallowing the address-completeness gate, the Thai
// tax-id checksum, the country ISO check, the DOB-required gate, and the
// branch/registrant cross-field rules all at once. This is exactly what
// happened in production: an admin's first click of Submit on a fresh
// (plan not yet picked) CREATE form showed 5 flat "required" errors and NO
// mention of the equally-missing address.
describe('buildMemberFormSchema — superRefine must still run when plan_id is UNSET, not just empty', () => {
  it('flags the missing address even though plan_id is `undefined` (first-submit shape)', () => {
    // Both plan_id AND the address are unset — the real empty-CREATE-form
    // shape a fresh admin's first Submit click actually produces.
    const {
      plan_id: _omitPlan,
      address_line1: _omitLine1,
      city: _omitCity,
      province: _omitProvince,
      sub_district: _omitSubDistrict,
      postal_code: _omitPostal,
      ...rest
    } = BASE;
    const paths = issuePaths(rest);
    // plan_id itself must still fail (it is required)…
    expect(paths).toContain('plan_id');
    // …but that must NOT suppress the superRefine-only checks below. Prior
    // to the fix, `paths` was exactly ['plan_id'] with every
    // superRefine-added path (including these) silently absent.
    expect(paths).toContain('address_line1');
    expect(paths).toContain('city');
    expect(paths).toContain('province');
    expect(paths).toContain('sub_district');
    expect(paths).toContain('postal_code');
  });

  it('still flags a bad Thai tax-id checksum even though plan_id is `undefined`', () => {
    const { plan_id: _omit, ...rest } = BASE;
    expect(
      issuePaths({ ...rest, tax_id: '0105556012345' }),
    ).toContain('tax_id');
  });

  it('still flags a bad branch pairing even though plan_id is `undefined`', () => {
    const { plan_id: _omit, ...rest } = BASE;
    expect(
      issuePaths({
        ...rest,
        is_head_office: false,
        branch_code: '123',
        legal_entity_type: 'company',
      }),
    ).toContain('branch_code');
  });
});
