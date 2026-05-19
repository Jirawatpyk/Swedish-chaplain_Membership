/**
 * T014 (Feature 013 / F6.1) — `classifyPdpaConsent` Domain helper tests.
 *
 * Per FR-009 + Clarifications Session 2026-05-15 post-critique Q1, the
 * helper classifies EventCreate's "Personal Data Protection Consent"
 * cell into the tri-state `PdpaConsentAcknowledged` value:
 *
 *   - true  — "hereby acknowledge"  (case-insensitive substring)
 *   - false — "do not consent"       (case-insensitive substring)
 *   - null  — missing / blank / dash / unrecognized / generic-CSV
 *
 * Plus a 1024-char truncation defence-in-depth guard.
 */
import { describe, it, expect } from 'vitest';
import { classifyPdpaConsent } from '@/modules/events/domain/eventcreate-csv-format';

describe('classifyPdpaConsent — true path', () => {
  it.each([
    'I hereby acknowledge that I have read and understood the privacy notice.',
    'i hereby acknowledge…',
    'HEREBY ACKNOWLEDGE',
    '  hereby acknowledge  ',
    'Yes, I hereby acknowledge the data handling.',
  ])('classifies as true: %s', (input) => {
    expect(classifyPdpaConsent(input)).toBe(true);
  });
});

describe('classifyPdpaConsent — false path', () => {
  it.each([
    'I do not consent to the processing.',
    'do not consent',
    'I DO NOT CONSENT under any circumstances.',
    'No - I do not consent.',
  ])('classifies as false: %s', (input) => {
    expect(classifyPdpaConsent(input)).toBe(false);
  });
});

describe('classifyPdpaConsent — null path (missing / unrecognized)', () => {
  it.each([
    null,
    undefined,
    '',
    '   ',
    '-', // hyphen
    '–', // en-dash
    'Some other text that does not match either keyword',
    'unsubscribe',
  ] as const)('classifies as null: %j', (input) => {
    expect(classifyPdpaConsent(input)).toBeNull();
  });
});

describe('classifyPdpaConsent — defence-in-depth', () => {
  it('truncates input at 1024 chars before substring search', () => {
    // A 5000-byte cell with the trigger phrase BEYOND the 1024 cap →
    // should NOT match (otherwise an attacker could exhaust regex
    // state-machine memory by passing a huge cell).
    const padding = 'x'.repeat(2000);
    const tail = ' hereby acknowledge';
    expect(classifyPdpaConsent(padding + tail)).toBeNull();
  });

  it('matches when trigger phrase is within the 1024-char window', () => {
    const padding = 'x'.repeat(500);
    const tail = ' hereby acknowledge';
    expect(classifyPdpaConsent(padding + tail)).toBe(true);
  });
});

describe('classifyPdpaConsent — true takes precedence over false', () => {
  // Highly unusual edge case: cell contains BOTH phrases. Spec says
  // first-match: "hereby acknowledge" check fires before "do not consent"
  // — so true wins. Documents the deterministic behavior so a future
  // schema change doesn't introduce ambiguity silently.
  it('returns true when both keywords appear', () => {
    expect(
      classifyPdpaConsent(
        'I hereby acknowledge I previously did not consent but now I do.',
      ),
    ).toBe(true);
  });
});
