/**
 * F8 R11 coverage closure — `at-risk-outreach.ts` Domain entity tests.
 *
 * Pins the OutreachId branding + parser, plus the OUTREACH_CHANNELS
 * canonical list and its parser against the migration 0090
 * `at_risk_outreach.channel` CHECK constraint.
 */
import { describe, expect, it } from 'vitest';
import {
  asOutreachId,
  parseOutreachChannel,
  parseOutreachId,
  OUTREACH_CHANNELS,
  type OutreachChannel,
} from '@/modules/renewals/domain/at-risk-outreach';

const VALID_UUID = '00000000-0000-0000-0000-000000000abc';

describe('asOutreachId — unchecked cast for trusted contexts', () => {
  it('returns the raw string branded as OutreachId', () => {
    const id = asOutreachId(VALID_UUID);
    expect(id).toBe(VALID_UUID);
  });

  it('does NOT validate format — caller is responsible', () => {
    // Documents the invariant: asOutreachId is for trusted DB rows /
    // fixtures only; untrusted input must use parseOutreachId.
    const id = asOutreachId('not-a-uuid');
    expect(id).toBe('not-a-uuid');
  });
});

describe('parseOutreachId — validating parser', () => {
  it('accepts a lowercase canonical UUID', () => {
    const r = parseOutreachId(VALID_UUID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_UUID);
  });

  it('accepts uppercase hex digits (case-insensitive)', () => {
    const upper = '00000000-0000-0000-0000-000000000ABC';
    const r = parseOutreachId(upper);
    expect(r.ok).toBe(true);
  });

  it('rejects non-UUID string', () => {
    const r = parseOutreachId('not-a-uuid');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid_outreach_id');
      expect(r.error.raw).toBe('not-a-uuid');
    }
  });

  it('rejects empty string', () => {
    const r = parseOutreachId('');
    expect(r.ok).toBe(false);
  });

  it('rejects UUID-shaped string missing hyphens', () => {
    const r = parseOutreachId('00000000000000000000000000000abc');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string typeof (defence-in-depth)', () => {
    // Cast through unknown — TS would reject this at compile time, but
    // runtime data from JSON.parse / DB rows can occasionally surface
    // a non-string here.
    const r = parseOutreachId(12345 as unknown as string);
    expect(r.ok).toBe(false);
  });
});

describe('OUTREACH_CHANNELS canonical list', () => {
  it('contains exactly the 3 channels mirrored in migration 0090 CHECK constraint', () => {
    expect(OUTREACH_CHANNELS).toEqual(['email', 'phone', 'meeting']);
  });
});

describe('parseOutreachChannel', () => {
  it.each([
    ['email', 'email'],
    ['phone', 'phone'],
    ['meeting', 'meeting'],
  ] as const)('accepts canonical channel %s', (input, expected) => {
    const r = parseOutreachChannel(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe<OutreachChannel>(expected);
  });

  it.each(['EMAIL', 'sms', '', 'in-person', 'video-call'] as const)(
    'rejects non-canonical channel %s',
    (raw) => {
      const r = parseOutreachChannel(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('invalid_outreach_channel');
        expect(r.error.raw).toBe(raw);
      }
    },
  );
});
