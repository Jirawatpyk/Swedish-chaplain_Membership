/**
 * R5 S007 — unit tests for `extractLatestChargeId` helper.
 *
 * Pinned shapes:
 *   - string id verbatim
 *   - expanded Charge object → `.id`
 *   - missing / null / other → undefined
 */
import { describe, it, expect } from 'vitest';

import { extractLatestChargeId } from '@/app/api/webhooks/stripe/route';

describe('extractLatestChargeId', () => {
  it('returns the string id when `latest_charge` is a string', () => {
    expect(extractLatestChargeId({ latest_charge: 'ch_123' })).toBe('ch_123');
  });

  it('returns the camelCase variant `latestChargeId` when present', () => {
    expect(extractLatestChargeId({ latestChargeId: 'ch_456' })).toBe('ch_456');
  });

  it('extracts `.id` from an expanded Charge object', () => {
    expect(
      extractLatestChargeId({
        latest_charge: { id: 'ch_789', amount: 12000, status: 'succeeded' },
      }),
    ).toBe('ch_789');
  });

  it('returns undefined when the expanded object has no string `id`', () => {
    expect(
      extractLatestChargeId({ latest_charge: { amount: 12000 } }),
    ).toBeUndefined();
    expect(
      extractLatestChargeId({ latest_charge: { id: 42 } }),
    ).toBeUndefined();
  });

  it('returns undefined when the field is missing / null / wrong primitive', () => {
    expect(extractLatestChargeId({})).toBeUndefined();
    expect(extractLatestChargeId(undefined)).toBeUndefined();
    expect(extractLatestChargeId({ latest_charge: null })).toBeUndefined();
    expect(extractLatestChargeId({ latest_charge: 42 })).toBeUndefined();
    expect(extractLatestChargeId({ latest_charge: true })).toBeUndefined();
  });

  it('snake_case wins when both keys are present (matches verifier convention)', () => {
    expect(
      extractLatestChargeId({
        latest_charge: 'ch_snake',
        latestChargeId: 'ch_camel',
      }),
    ).toBe('ch_snake');
  });
});
