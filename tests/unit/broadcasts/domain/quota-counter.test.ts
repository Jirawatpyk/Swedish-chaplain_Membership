/**
 * T039 — Unit tests for the F7 quota-counter VO.
 *
 * Verifies invariants per FR-008: `used + reserved <= cap`,
 * `remaining = cap - used - reserved`, never negative. Each branch
 * surfaces a discriminated `QuotaCounterError`.
 */
import { describe, expect, it } from 'vitest';
import {
  asQuotaCounter,
  hasRemainingSlot,
  zeroQuota,
} from '@/modules/broadcasts';

describe('asQuotaCounter', () => {
  it('computes remaining = cap - used - reserved on happy path', () => {
    const result = asQuotaCounter({ used: 2, reserved: 1, cap: 6 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        used: 2,
        reserved: 1,
        remaining: 3,
        cap: 6,
      });
    }
  });

  it('returns negative_cap on cap < 0', () => {
    const result = asQuotaCounter({ used: 0, reserved: 0, cap: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('quota_counter.negative_cap');
  });

  it('returns negative_used on used < 0', () => {
    const result = asQuotaCounter({ used: -1, reserved: 0, cap: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('quota_counter.negative_used');
  });

  it('returns negative_reserved on reserved < 0', () => {
    const result = asQuotaCounter({ used: 0, reserved: -1, cap: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.code).toBe('quota_counter.negative_reserved');
  });

  it('returns over_subscription when used + reserved > cap', () => {
    const result = asQuotaCounter({ used: 4, reserved: 3, cap: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('quota_counter.over_subscription');
      if (result.error.code === 'quota_counter.over_subscription') {
        expect(result.error.used).toBe(4);
        expect(result.error.reserved).toBe(3);
        expect(result.error.cap).toBe(6);
      }
    }
  });

  it('returns non_integer for fractional used', () => {
    const result = asQuotaCounter({ used: 1.5, reserved: 0, cap: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('quota_counter.non_integer');
    if (!result.ok && result.error.code === 'quota_counter.non_integer') {
      expect(result.error.field).toBe('used');
    }
  });

  it('returns non_integer for fractional reserved', () => {
    const result = asQuotaCounter({ used: 0, reserved: 0.5, cap: 6 });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'quota_counter.non_integer') {
      expect(result.error.field).toBe('reserved');
      expect(result.error.value).toBe(0.5);
    }
  });

  it('returns non_integer for fractional cap', () => {
    const result = asQuotaCounter({ used: 0, reserved: 0, cap: 6.5 });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'quota_counter.non_integer') {
      expect(result.error.field).toBe('cap');
      expect(result.error.value).toBe(6.5);
    }
  });

  it('boundary: used + reserved exactly equal to cap returns remaining = 0', () => {
    const result = asQuotaCounter({ used: 3, reserved: 3, cap: 6 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.remaining).toBe(0);
  });

  it('boundary: cap = 0 with used = 0 + reserved = 0 ok', () => {
    const result = asQuotaCounter({ used: 0, reserved: 0, cap: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({
      used: 0,
      reserved: 0,
      remaining: 0,
      cap: 0,
    });
  });
});

describe('zeroQuota', () => {
  it('returns counter with cap and zero used/reserved', () => {
    const counter = zeroQuota(6);
    expect(counter).toEqual({ used: 0, reserved: 0, remaining: 6, cap: 6 });
  });

  it('clamps negative cap to 0', () => {
    const counter = zeroQuota(-3);
    expect(counter.cap).toBe(0);
    expect(counter.remaining).toBe(0);
  });
});

describe('hasRemainingSlot', () => {
  it('true when remaining > 0', () => {
    expect(hasRemainingSlot({ used: 1, reserved: 0, remaining: 5, cap: 6 })).toBe(
      true,
    );
  });

  it('false when remaining = 0', () => {
    expect(hasRemainingSlot({ used: 6, reserved: 0, remaining: 0, cap: 6 })).toBe(
      false,
    );
  });
});
