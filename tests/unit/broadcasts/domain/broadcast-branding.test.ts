/**
 * Wave 6b — Branded ID parsers for F7 Domain entities.
 *
 * Coverage push for parseBroadcastId + parseBroadcastDeliveryId +
 * parseBroadcastSegmentDefinitionId — UUID validation for untrusted
 * input. `asXxxId` (unsafe brand cast) is exercised throughout the
 * other test suites; this file pins the parse-with-validation paths.
 */
import { describe, expect, it } from 'vitest';
import {
  asBroadcastDeliveryId,
  asBroadcastId,
  asBroadcastSegmentDefinitionId,
  parseBroadcastDeliveryId,
  parseBroadcastId,
  parseBroadcastSegmentDefinitionId,
} from '@/modules/broadcasts';

const VALID_UUID = '11111111-1111-4111-8111-111111111111';

describe('parseBroadcastId', () => {
  it('accepts a well-formed UUID v4-shape string', () => {
    const result = parseBroadcastId(VALID_UUID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(VALID_UUID);
    }
  });

  it('rejects malformed UUID with invalid_broadcast_id', () => {
    const result = parseBroadcastId('not-a-uuid');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_broadcast_id');
      expect(result.error.raw).toBe('not-a-uuid');
    }
  });

  it('rejects empty string', () => {
    const result = parseBroadcastId('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_broadcast_id');
    }
  });

  it('rejects non-string (defensive guard)', () => {
    const result = parseBroadcastId(123 as unknown as string);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_broadcast_id');
    }
  });
});

describe('asBroadcastId (unsafe brand cast)', () => {
  it('round-trips a string unchanged', () => {
    expect(asBroadcastId(VALID_UUID)).toBe(VALID_UUID);
  });
});

describe('parseBroadcastDeliveryId', () => {
  it('accepts well-formed UUID', () => {
    const result = parseBroadcastDeliveryId(VALID_UUID);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed UUID', () => {
    const result = parseBroadcastDeliveryId('xx');
    expect(result.ok).toBe(false);
  });
});

describe('asBroadcastDeliveryId', () => {
  it('round-trips a string unchanged', () => {
    expect(asBroadcastDeliveryId(VALID_UUID)).toBe(VALID_UUID);
  });
});

describe('parseBroadcastSegmentDefinitionId', () => {
  it('accepts well-formed UUID', () => {
    const result = parseBroadcastSegmentDefinitionId(VALID_UUID);
    expect(result.ok).toBe(true);
  });

  it('rejects malformed UUID', () => {
    const result = parseBroadcastSegmentDefinitionId('not-uuid');
    expect(result.ok).toBe(false);
  });
});

describe('asBroadcastSegmentDefinitionId', () => {
  it('round-trips a string unchanged', () => {
    expect(asBroadcastSegmentDefinitionId(VALID_UUID)).toBe(VALID_UUID);
  });
});
