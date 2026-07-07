/**
 * PR 4.2 (#10a) — Unit tests for the CSV column-mapping domain validator.
 *
 * `parseColumnMappingObject` is the single fail-closed gate the import
 * route uses to validate the admin-supplied `column_mapping` field (a NEW
 * external input boundary). It MUST reject non-objects, non-canonical
 * targets, and oversized maps, and return a header→canonical `Map` (the
 * direction the parser expects) on success.
 *
 * Pure Domain unit — no framework/DB. Constitution: Domain 100% line.
 */
import { describe, expect, it } from 'vitest';
import {
  parseColumnMappingObject,
  CSV_CANONICAL_COLUMNS,
  CSV_CANONICAL_COLUMN_SET,
  CSV_REQUIRED_COLUMNS,
  CSV_GENERIC_REQUIRED_COLUMNS,
  MAX_COLUMN_MAPPING_ENTRIES,
  MAX_COLUMN_MAPPING_KEY_LENGTH,
} from '@/modules/events/domain/csv-column-mapping';

describe('CSV column-mapping canonical constants', () => {
  it('canonical set contains the 5 required + optional columns', () => {
    for (const col of CSV_REQUIRED_COLUMNS) {
      expect(CSV_CANONICAL_COLUMN_SET.has(col)).toBe(true);
    }
    expect(CSV_CANONICAL_COLUMNS).toContain('event_external_id');
    expect(CSV_CANONICAL_COLUMNS).toContain('attendee_email');
    expect(CSV_CANONICAL_COLUMNS).toContain('ticket_type');
  });

  it('the reduced generic-required set is exactly the two attendee columns', () => {
    expect([...CSV_GENERIC_REQUIRED_COLUMNS]).toEqual([
      'attendee_email',
      'attendee_name',
    ]);
  });
});

describe('parseColumnMappingObject — fail-closed validation', () => {
  it('accepts a valid header→canonical object and returns a Map keyed by header', () => {
    const result = parseColumnMappingObject({
      'Email Address': 'attendee_email',
      'Full Name': 'attendee_name',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapping).toBeInstanceOf(Map);
    expect(result.mapping.get('Email Address')).toBe('attendee_email');
    expect(result.mapping.get('Full Name')).toBe('attendee_name');
    // NOT inverted.
    expect(result.mapping.get('attendee_email')).toBeUndefined();
  });

  it('rejects null', () => {
    expect(parseColumnMappingObject(null).ok).toBe(false);
  });

  it('rejects a primitive (string)', () => {
    expect(parseColumnMappingObject('attendee_email').ok).toBe(false);
  });

  it('rejects an array (JSON array is not a mapping object)', () => {
    expect(parseColumnMappingObject(['attendee_email']).ok).toBe(false);
  });

  it('rejects a target value that is not a canonical column', () => {
    const result = parseColumnMappingObject({
      'Email Address': 'not_a_canonical_field',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/canonical/);
  });

  it('rejects a non-string target value', () => {
    const result = parseColumnMappingObject({ 'Email Address': 42 });
    expect(result.ok).toBe(false);
  });

  it('rejects when there are too many entries', () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < MAX_COLUMN_MAPPING_ENTRIES + 1; i++) {
      big[`header_${i}`] = 'attendee_email';
    }
    const result = parseColumnMappingObject(big);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty-string key', () => {
    const result = parseColumnMappingObject({ '': 'attendee_email' });
    expect(result.ok).toBe(false);
  });

  it('rejects an over-long key', () => {
    const longKey = 'x'.repeat(MAX_COLUMN_MAPPING_KEY_LENGTH + 1);
    const result = parseColumnMappingObject({ [longKey]: 'attendee_email' });
    expect(result.ok).toBe(false);
  });

  it('accepts an empty object as a no-op (empty Map)', () => {
    const result = parseColumnMappingObject({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mapping.size).toBe(0);
  });
});
