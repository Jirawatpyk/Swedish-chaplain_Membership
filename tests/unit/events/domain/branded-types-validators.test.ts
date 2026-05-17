/**
 * R3.2.1 / CG-1 — Unit tests for the UUID v4 brand constructors.
 *
 * Phase H3.3 renamed `asEventIdValidated` → `asEventId` (default now
 * validates UUID v4). This file pins:
 *   - The regex passes / rejects per RFC 4122 §4.4 (variant nibble in
 *     position 19 must be 8/9/a/b; version nibble in position 14 must
 *     be 4).
 *   - The `try*` variants return null instead of throwing.
 *   - The `*Unchecked` variants accept any non-empty string (DB row-read
 *     trust contract).
 *
 * Without these tests, a future refactor that loosened the regex (e.g.,
 * accepted v1-5) would silently slip through — the gate guarding every
 * HTTP/CSV ingest boundary.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  asEventId,
  asEventIdUnchecked,
  asRegistrationId,
  asRegistrationIdUnchecked,
  tryEventId,
  tryEventIdUnchecked,
  tryRegistrationId,
  tryRegistrationIdUnchecked,
} from '@/modules/events/domain/branded-types';

// 5 valid v4 UUIDs — variant nibble = 8/9/a/b; version nibble = 4.
const VALID_V4_FIXTURES = [
  '11111111-2222-4333-8444-555555555555',
  'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
  '00000000-0000-4000-a000-000000000000',
  'ffffffff-ffff-4fff-bfff-ffffffffffff',
  // Mixed case (regex /i flag must accept):
  'ABCDEF01-2345-4678-9ABC-DEF012345678',
];

// Invalid UUIDs by various failure mode:
const INVALID_FIXTURES_REJECT = {
  emptyString: '',
  tooShort: '11111111-2222-4333-8444-55555555555', // missing 1 hex
  tooLong: '11111111-2222-4333-8444-5555555555555', // extra hex
  notAUuid: 'not-a-uuid',
  // Version-nibble wrong (RFC 4122 §4.4 — position 14 must be 4):
  v1: '00000000-0000-1000-8000-000000000000',
  v3: '00000000-0000-3000-8000-000000000000',
  v5: '00000000-0000-5000-8000-000000000000',
  v7: '00000000-0000-7000-8000-000000000000',
  // Variant-nibble wrong (position 19 must be 8/9/a/b):
  variantC: '00000000-0000-4000-c000-000000000000',
  variantD: '00000000-0000-4000-d000-000000000000',
  variantE: '00000000-0000-4000-e000-000000000000',
  variantF: '00000000-0000-4000-f000-000000000000',
  variant0: '00000000-0000-4000-0000-000000000000',
  variant7: '00000000-0000-4000-7000-000000000000',
  // Non-hex chars:
  nonHex: 'gggggggg-0000-4000-8000-000000000000',
  // Wrong separators:
  noHyphens: '111111112222433384445555555 5555 5',
  // Number that's coincidentally 36 chars:
  randomThirtySix: '01234567890123456789012345678901234',
};

describe('R3.2.1 — asEventId (validated UUID v4 default)', () => {
  it.each(VALID_V4_FIXTURES)(
    'accepts valid UUID v4: %s',
    (input) => {
      const result = asEventId(input);
      expect(result).toBe(input);
      // Brand is a type-level concept; structural check that the
      // function returned the raw string (the cast is lossless at
      // runtime).
      expect(typeof result).toBe('string');
    },
  );

  it.each(Object.entries(INVALID_FIXTURES_REJECT))(
    'rejects %s: %s',
    (_label, input) => {
      expect(() => asEventId(input)).toThrow(/UUID v4/);
    },
  );

  it('property: every fast-check v4 UUID is accepted', () => {
    fc.assert(
      fc.property(fc.uuid({ version: 4 }), (uuid) => {
        // fast-check v4 UUIDs may use uppercase or lowercase — our
        // regex is case-insensitive (/i), so all variants pass.
        expect(() => asEventId(uuid)).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });

  it('R5.6 / Round 4 tests-Important #9 — independent v4-shape check property (not tautological with validator)', () => {
    // Round 4 caught that the prior "rejects non-v4 strings" property
    // used the SAME regex as the validator to filter inputs — a
    // regression that loosens the regex (e.g. accepts v1/v3/v5) would
    // simultaneously loosen the test filter, hiding the bug.
    //
    // This property uses an INDEPENDENT structural check: count
    // hyphens at positions 8/13/18/23, version-nibble at position 14,
    // variant-nibble at position 19, and total length === 36. If the
    // independent check says "not v4 shaped" then the validator MUST
    // reject.
    fc.assert(
      fc.property(fc.string({ minLength: 36, maxLength: 36 }), (s) => {
        const isV4Shape =
          s.length === 36 &&
          s[8] === '-' &&
          s[13] === '-' &&
          s[18] === '-' &&
          s[23] === '-' &&
          s[14] === '4' &&
          (s[19] !== undefined &&
            ['8', '9', 'a', 'b', 'A', 'B'].includes(s[19])) &&
          /^[0-9a-fA-F-]{36}$/.test(s);
        if (!isV4Shape) {
          expect(() => asEventId(s)).toThrow();
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('R3.2.1 — asRegistrationId (validated UUID v4 default)', () => {
  it.each(VALID_V4_FIXTURES)(
    'accepts valid UUID v4: %s',
    (input) => {
      const result = asRegistrationId(input);
      expect(result).toBe(input);
    },
  );

  it.each(Object.entries(INVALID_FIXTURES_REJECT))(
    'rejects %s',
    (_label, input) => {
      expect(() => asRegistrationId(input)).toThrow(/UUID v4/);
    },
  );
});

describe('R3.2.1 — tryEventId (validated, null on failure)', () => {
  it.each(VALID_V4_FIXTURES)('accepts valid UUID v4: %s', (input) => {
    expect(tryEventId(input)).toBe(input);
  });

  it.each(Object.entries(INVALID_FIXTURES_REJECT))(
    'returns null for %s',
    (_label, input) => {
      expect(tryEventId(input)).toBeNull();
    },
  );

  it('returns null for non-string input', () => {
    expect(tryEventId(undefined)).toBeNull();
    expect(tryEventId(null)).toBeNull();
    expect(tryEventId(42)).toBeNull();
    expect(tryEventId({})).toBeNull();
    expect(tryEventId([])).toBeNull();
  });
});

describe('R3.2.1 — tryRegistrationId (validated, null on failure)', () => {
  it.each(VALID_V4_FIXTURES)('accepts valid UUID v4: %s', (input) => {
    expect(tryRegistrationId(input)).toBe(input);
  });

  it.each(Object.entries(INVALID_FIXTURES_REJECT))(
    'returns null for %s',
    (_label, input) => {
      expect(tryRegistrationId(input)).toBeNull();
    },
  );

  it('returns null for non-string input', () => {
    expect(tryRegistrationId(undefined)).toBeNull();
    expect(tryRegistrationId(null)).toBeNull();
    expect(tryRegistrationId(42)).toBeNull();
  });
});

describe('R3.2.1 — *Unchecked variants accept non-empty strings', () => {
  // The Unchecked variants are reserved for hot-path Drizzle row reads
  // where the DB column `uuid DEFAULT gen_random_uuid()` guarantees
  // the shape. They MUST NOT reject malformed UUIDs (that's the whole
  // point — they skip the regex).

  it('asEventIdUnchecked accepts any non-empty string', () => {
    expect(asEventIdUnchecked('not-a-uuid-at-all')).toBe('not-a-uuid-at-all');
    expect(asEventIdUnchecked('11111111-2222-4333-8444-555555555555')).toBe(
      '11111111-2222-4333-8444-555555555555',
    );
    // Even a 1-char string is accepted — DB column type bounds the shape.
    expect(asEventIdUnchecked('a')).toBe('a');
  });

  it('asEventIdUnchecked rejects empty string only', () => {
    expect(() => asEventIdUnchecked('')).toThrow(/non-empty string/);
  });

  it('asRegistrationIdUnchecked accepts any non-empty string', () => {
    expect(asRegistrationIdUnchecked('not-a-uuid')).toBe('not-a-uuid');
    expect(asRegistrationIdUnchecked('a')).toBe('a');
  });

  it('asRegistrationIdUnchecked rejects empty string only', () => {
    expect(() => asRegistrationIdUnchecked('')).toThrow(/non-empty string/);
  });

  it('tryEventIdUnchecked + tryRegistrationIdUnchecked return null for non-strings + empty', () => {
    expect(tryEventIdUnchecked(undefined)).toBeNull();
    expect(tryEventIdUnchecked(null)).toBeNull();
    expect(tryEventIdUnchecked('')).toBeNull();
    expect(tryEventIdUnchecked('not-a-uuid')).toBe('not-a-uuid');

    expect(tryRegistrationIdUnchecked(undefined)).toBeNull();
    expect(tryRegistrationIdUnchecked('')).toBeNull();
    expect(tryRegistrationIdUnchecked('also-fine')).toBe('also-fine');
  });
});
