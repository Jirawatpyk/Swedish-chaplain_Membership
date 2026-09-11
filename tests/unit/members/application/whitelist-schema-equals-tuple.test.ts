/**
 * T116 — FR-014a whitelist-schema-equals-tuple test.
 *
 * Asserts that the zod schema keys used by `member-self-update.ts`
 * are EXACTLY equal to the compile-time tuples in
 * `portal-self-update-fields.ts`. If a developer adds a field to one
 * but forgets the other, this test fails red — preventing whitelist
 * drift that would either block legitimate self-service edits or
 * silently allow forged payloads through.
 */
import { describe, expect, it } from 'vitest';
import {
  PORTAL_IMMEDIATE_CONTACT_FIELDS,
  PORTAL_IMMEDIATE_MEMBER_FIELDS,
  PORTAL_SELF_UPDATE_CONTACT_FIELDS,
  PORTAL_SELF_UPDATE_MEMBER_FIELDS,
} from '@/modules/members/domain/portal-self-update-fields';
import {
  SELF_UPDATE_CONTACT_SCHEMA_KEYS,
  SELF_UPDATE_MEMBER_SCHEMA_KEYS,
} from '@/modules/members/application/use-cases/member-self-update';

describe('FR-014a: whitelist schema keys === Domain tuples (T116)', () => {
  it('contact schema keys match PORTAL_SELF_UPDATE_CONTACT_FIELDS exactly', () => {
    const tupleKeys = [...PORTAL_SELF_UPDATE_CONTACT_FIELDS].sort();
    expect(SELF_UPDATE_CONTACT_SCHEMA_KEYS).toEqual(tupleKeys);
  });

  it('member schema keys match PORTAL_SELF_UPDATE_MEMBER_FIELDS exactly', () => {
    const tupleKeys = [...PORTAL_SELF_UPDATE_MEMBER_FIELDS].sort();
    expect(SELF_UPDATE_MEMBER_SCHEMA_KEYS).toEqual(tupleKeys);
  });

  it('contact tuple has expected fields', () => {
    expect(PORTAL_SELF_UPDATE_CONTACT_FIELDS).toEqual([
      'firstName',
      'lastName',
      'phone',
      'preferredLanguage',
    ]);
  });

  it('member tuple has expected fields', () => {
    expect(PORTAL_SELF_UPDATE_MEMBER_FIELDS).toEqual([
      'website',
      'description',
    ]);
  });

  // F114 FR-004 / R6 — Group A (immediate while the gate is on) is a strict
  // subset of the flag-OFF set: the contact's own notification language only.
  it('Group A (gate = approval) is exactly the contact preferredLanguage, and a subset of the flag-OFF set', () => {
    expect(PORTAL_IMMEDIATE_CONTACT_FIELDS).toEqual(['preferredLanguage']);
    expect(PORTAL_IMMEDIATE_MEMBER_FIELDS).toEqual([]);
    for (const key of PORTAL_IMMEDIATE_CONTACT_FIELDS) {
      expect(PORTAL_SELF_UPDATE_CONTACT_FIELDS).toContain(key);
    }
    // Every flag-OFF contact key outside Group A is a Group B key while the
    // gate is on (firstName / lastName / phone become change-request fields).
    const groupB = PORTAL_SELF_UPDATE_CONTACT_FIELDS.filter(
      (k) => !(PORTAL_IMMEDIATE_CONTACT_FIELDS as readonly string[]).includes(k),
    );
    expect(groupB).toEqual(['firstName', 'lastName', 'phone']);
  });
});
