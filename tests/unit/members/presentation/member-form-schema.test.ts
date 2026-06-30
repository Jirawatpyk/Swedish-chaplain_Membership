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

const BASE = {
  company_name: 'Acme',
  country: 'TH',
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
