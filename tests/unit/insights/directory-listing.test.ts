/**
 * F9 US5 (T077) — `DirectoryListing` domain unit tests.
 *
 * Pins FR-024/FR-025/FR-028 + SC-007 (zero-leakage):
 *   - the fixed directory field set + visibility validation,
 *   - default-private / email-default-hidden policy,
 *   - the published-listing projection: only `listed=true` members appear, only
 *     fields with `fieldVisibility[field]=true` are emitted, a present-but-hidden
 *     email is replaced with a contact-form indicator, and a visible-but-empty
 *     field is omitted (no empty/NaN artefacts).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIELD_VISIBILITY,
  DIRECTORY_FIELDS,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  isDescriptionWithinCap,
  isDirectoryField,
  isFieldVisible,
  isValidDirectoryWebsite,
  projectPublishedListing,
  sanitizeFieldVisibility,
  type DirectoryRecord,
} from '@/modules/insights/domain/directory-listing';

const identity = {
  memberName: 'Acme Co., Ltd.',
  tier: 'Corporate Gold',
  contactName: 'Somchai P.',
  contactEmail: 'somchai@acme.example',
} as const;

const metadata = {
  industry: 'Manufacturing',
  description: 'We make widgets.',
  website: 'https://acme.example',
  logoUrl: 'https://blob.example/acme-logo.png',
  locationCity: 'Bangkok',
  locationCountry: 'TH',
} as const;

const allVisible = Object.fromEntries(
  DIRECTORY_FIELDS.map((f) => [f, true]),
) as Record<(typeof DIRECTORY_FIELDS)[number], boolean>;

const baseRecord: DirectoryRecord = {
  listed: true,
  fieldVisibility: allVisible,
  identity,
  metadata,
};

describe('directory field set (FR-025)', () => {
  it('is the fixed 9-field set', () => {
    expect([...DIRECTORY_FIELDS]).toEqual([
      'name',
      'tier',
      'industry',
      'description',
      'website',
      'logo',
      'location',
      'contact_name',
      'contact_email',
    ]);
  });

  it('isDirectoryField narrows known keys only', () => {
    expect(isDirectoryField('name')).toBe(true);
    expect(isDirectoryField('contact_email')).toBe(true);
    expect(isDirectoryField('phone')).toBe(false);
    expect(isDirectoryField('__proto__')).toBe(false);
  });

  it('default visibility hides email, exposes the rest (FR-025 email default-hidden)', () => {
    expect(DEFAULT_FIELD_VISIBILITY.contact_email).toBe(false);
    expect(DEFAULT_FIELD_VISIBILITY.name).toBe(true);
    expect(DEFAULT_FIELD_VISIBILITY.tier).toBe(true);
    expect(DEFAULT_FIELD_VISIBILITY.location).toBe(true);
  });
});

describe('sanitizeFieldVisibility', () => {
  it('drops unknown keys and coerces values to booleans', () => {
    const out = sanitizeFieldVisibility({
      name: true,
      contact_email: false,
      phone: true, // unknown → dropped
      website: 'yes', // truthy non-bool → true
      tier: 0, // falsy non-bool → false
    });
    expect(out).toEqual({
      name: true,
      contact_email: false,
      website: true,
      tier: false,
    });
    expect('phone' in out).toBe(false);
  });

  it('non-object input → empty visibility', () => {
    expect(sanitizeFieldVisibility(null)).toEqual({});
    expect(sanitizeFieldVisibility('nope')).toEqual({});
    expect(sanitizeFieldVisibility(undefined)).toEqual({});
  });

  it('ignores the prototype-pollution keys', () => {
    const out = sanitizeFieldVisibility(
      JSON.parse('{"__proto__": {"name": true}, "name": true}'),
    );
    expect(out).toEqual({ name: true });
  });
});

describe('isFieldVisible', () => {
  it('absent key → not visible (publication default-deny)', () => {
    expect(isFieldVisible({}, 'name')).toBe(false);
  });
  it('explicit true → visible; explicit false → not', () => {
    expect(isFieldVisible({ name: true }, 'name')).toBe(true);
    expect(isFieldVisible({ name: false }, 'name')).toBe(false);
  });
});

describe('field validators (DB-CHECK parity)', () => {
  it('website scheme allow-list = http/https only', () => {
    expect(isValidDirectoryWebsite('https://acme.example')).toBe(true);
    expect(isValidDirectoryWebsite('http://acme.example')).toBe(true);
    expect(isValidDirectoryWebsite('HTTP://ACME.EXAMPLE')).toBe(true);
    expect(isValidDirectoryWebsite('ftp://acme.example')).toBe(false);
    expect(isValidDirectoryWebsite('javascript:alert(1)')).toBe(false);
    expect(isValidDirectoryWebsite('acme.example')).toBe(false);
    expect(isValidDirectoryWebsite('')).toBe(false);
  });

  it('description cap matches the 500-char DB CHECK', () => {
    expect(MAX_DIRECTORY_DESCRIPTION_LENGTH).toBe(500);
    expect(isDescriptionWithinCap('a'.repeat(500))).toBe(true);
    expect(isDescriptionWithinCap('a'.repeat(501))).toBe(false);
    expect(isDescriptionWithinCap('')).toBe(true);
  });
});

describe('projectPublishedListing (FR-028 / SC-007 zero-leakage)', () => {
  it('an un-listed member projects to null (never appears in published output)', () => {
    expect(projectPublishedListing({ ...baseRecord, listed: false })).toBeNull();
  });

  it('listed + all fields visible → every field present', () => {
    const out = projectPublishedListing(baseRecord);
    expect(out).not.toBeNull();
    expect(out).toEqual({
      name: 'Acme Co., Ltd.',
      tier: 'Corporate Gold',
      industry: 'Manufacturing',
      description: 'We make widgets.',
      website: 'https://acme.example',
      logoUrl: 'https://blob.example/acme-logo.png',
      location: { city: 'Bangkok', country: 'TH' },
      contact: { name: 'Somchai P.', email: 'somchai@acme.example' },
    });
  });

  it('AS-3: hidden email + present contact → email omitted, contact-form indicator set', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      fieldVisibility: { ...allVisible, contact_email: false },
    });
    expect(out?.contact).toEqual({ name: 'Somchai P.', contactForm: true });
    expect(out?.contact).not.toHaveProperty('email');
  });

  it('a visible field whose underlying value is null is omitted (no empty artefacts)', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      metadata: { ...metadata, industry: null, website: null, logoUrl: null },
    });
    expect(out).not.toHaveProperty('industry');
    expect(out).not.toHaveProperty('website');
    expect(out).not.toHaveProperty('logoUrl');
    expect(out?.name).toBe('Acme Co., Ltd.');
  });

  it('location with only a city emits just the city', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      metadata: { ...metadata, locationCountry: null },
    });
    expect(out?.location).toEqual({ city: 'Bangkok' });
  });

  it('a member with no contact at all emits no contact object', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      identity: { ...identity, contactName: null, contactEmail: null },
    });
    expect(out).not.toHaveProperty('contact');
  });

  it('hidden contact_name but visible email → email shown, no name', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      fieldVisibility: { ...allVisible, contact_name: false },
    });
    expect(out?.contact).toEqual({ email: 'somchai@acme.example' });
  });

  it('both contact fields hidden → no contact object (form replaces a hidden email only when the contact is presented)', () => {
    const out = projectPublishedListing({
      ...baseRecord,
      fieldVisibility: {
        ...allVisible,
        contact_name: false,
        contact_email: false,
      },
    });
    expect(out).not.toHaveProperty('contact');
  });

  it('empty visibility map → listed member with no exposed fields (SC-007 default-deny)', () => {
    const out = projectPublishedListing({ ...baseRecord, fieldVisibility: {} });
    expect(out).toEqual({});
  });
});
