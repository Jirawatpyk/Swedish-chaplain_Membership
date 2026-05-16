/**
 * Staff-review R3 (2026-05-16) — bring `CsvImportRecordId` smart-
 * constructor coverage to 100% to satisfy the per-file H-4 threshold.
 *
 * Prior to R3, this branded type's `asX`/`tryX` functions were only
 * partially covered by `generate-error-csv-signed-url.test.ts` (happy
 * path) — the throw branch and the `unknown`-shape branches were
 * unexercised. Adding direct tests pins both branches against future
 * regressions.
 *
 * Branded type pattern reference: `src/modules/events/domain/csv-import-record-id.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  asCsvImportRecordId,
  tryCsvImportRecordId,
} from '@/modules/events/domain/csv-import-record-id';

// Valid UUID v4 — has the canonical `4` version nibble and `[89ab]`
// variant nibble per RFC 4122 §4.4.
const VALID_UUID_V4 = '550e8400-e29b-41d4-a716-446655440000';
// Valid lowercase variant — the regex is case-insensitive.
const VALID_UUID_V4_LOWER = 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee';

describe('asCsvImportRecordId — smart constructor (throwing)', () => {
  it('returns the branded value when input is a canonical UUID v4', () => {
    const branded = asCsvImportRecordId(VALID_UUID_V4);
    expect(branded).toBe(VALID_UUID_V4);
  });

  it('accepts lowercase UUID v4 (regex is case-insensitive)', () => {
    const branded = asCsvImportRecordId(VALID_UUID_V4_LOWER);
    expect(branded).toBe(VALID_UUID_V4_LOWER);
  });

  it('throws on non-UUID input (no version nibble)', () => {
    expect(() => asCsvImportRecordId('not-a-uuid')).toThrow(
      /CsvImportRecordId must be a valid UUID v4/,
    );
  });

  it('throws on UUID v1 shape (wrong version nibble)', () => {
    // Version nibble = 1 instead of 4
    expect(() =>
      asCsvImportRecordId('550e8400-e29b-11d4-a716-446655440000'),
    ).toThrow(/RFC 4122/);
  });

  it('throws on UUID with wrong variant nibble (invalid `c`)', () => {
    // Variant nibble must be 8/9/a/b — `c` is not valid for RFC 4122 §4.4
    expect(() =>
      asCsvImportRecordId('550e8400-e29b-41d4-c716-446655440000'),
    ).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => asCsvImportRecordId('')).toThrow();
  });
});

describe('tryCsvImportRecordId — non-throwing variant', () => {
  it('returns the branded value when input is a canonical UUID v4', () => {
    expect(tryCsvImportRecordId(VALID_UUID_V4)).toBe(VALID_UUID_V4);
  });

  it('returns null when input is not a string (number)', () => {
    expect(tryCsvImportRecordId(42)).toBeNull();
  });

  it('returns null when input is not a string (object)', () => {
    expect(tryCsvImportRecordId({ recordId: VALID_UUID_V4 })).toBeNull();
  });

  it('returns null when input is null', () => {
    expect(tryCsvImportRecordId(null)).toBeNull();
  });

  it('returns null when input is undefined', () => {
    expect(tryCsvImportRecordId(undefined)).toBeNull();
  });

  it('returns null when input is a string but not a UUID', () => {
    expect(tryCsvImportRecordId('not-a-uuid')).toBeNull();
  });

  it('returns null when input is a UUID with wrong version nibble', () => {
    expect(
      tryCsvImportRecordId('550e8400-e29b-11d4-a716-446655440000'),
    ).toBeNull();
  });
});
