/**
 * `classifyTokenFailure()` + `isResetTokenValid` + `isInvitationValid`
 * unit tests (spec FR-005, T-15).
 *
 * `classifyTokenFailure` drives the 404-vs-410 HTTP status split in
 * two route handlers (`reset-password/route.ts` and
 * `redeem-invite/route.ts`). A one-character inversion in the branches
 * (`!== null` vs `=== null`) would silently corrupt the status mapping
 * for every password reset and invitation redemption, breaking T-15
 * enumeration-safety assumptions. Pin every branch here.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyTokenFailure,
  isResetTokenValid,
  isInvitationValid,
  RESET_TOKEN_TTL_MS,
  INVITATION_TTL_MS,
} from '@/modules/auth/domain/token';

describe('classifyTokenFailure()', () => {
  it('returns "not-found" when the token argument is null', () => {
    expect(classifyTokenFailure(null)).toBe('not-found');
  });

  it('returns "used" when the token has a non-null consumedAt', () => {
    const past = new Date('2026-01-15T10:00:00Z');
    expect(classifyTokenFailure({ consumedAt: past })).toBe('used');
  });

  it('returns "expired" when the token exists but consumedAt is null', () => {
    // Caller guarantees this only fires when `isResetTokenValid` /
    // `isInvitationValid` returned false — so "not consumed + not
    // valid" implies expired.
    expect(classifyTokenFailure({ consumedAt: null })).toBe('expired');
  });

  it('handles a token with consumedAt set to epoch (truthy but old)', () => {
    // Edge case: a Date object of epoch-0 is still truthy. The function
    // should still classify it as 'used' because the field is non-null.
    expect(classifyTokenFailure({ consumedAt: new Date(0) })).toBe('used');
  });
});

describe('isResetTokenValid()', () => {
  const baseToken = {
    id: 'test' as never,
    userId: 'user' as never,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T01:00:00Z'), // 1-hour TTL
    consumedAt: null,
  };

  it('returns true for an unconsumed, unexpired token', () => {
    const now = new Date('2026-01-01T00:30:00Z'); // halfway through TTL
    expect(isResetTokenValid(baseToken, now)).toBe(true);
  });

  it('returns false if consumedAt is set', () => {
    const now = new Date('2026-01-01T00:30:00Z');
    const consumed = { ...baseToken, consumedAt: now };
    expect(isResetTokenValid(consumed, now)).toBe(false);
  });

  it('returns false if expiresAt has passed', () => {
    const now = new Date('2026-01-01T02:00:00Z'); // 1 h past expiry
    expect(isResetTokenValid(baseToken, now)).toBe(false);
  });

  it('returns false if expiresAt equals now (boundary is exclusive)', () => {
    const exactlyAtExpiry = baseToken.expiresAt;
    expect(isResetTokenValid(baseToken, exactlyAtExpiry)).toBe(false);
  });
});

describe('isInvitationValid()', () => {
  const baseInvite = {
    id: 'test' as never,
    userId: 'user' as never,
    invitedByUserId: 'admin' as never,
    intendedRole: 'member' as const,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-08T00:00:00Z'), // 7-day TTL
    consumedAt: null,
  };

  it('returns true for an unconsumed, unexpired invitation', () => {
    const now = new Date('2026-01-04T00:00:00Z'); // 3 days in
    expect(isInvitationValid(baseInvite, now)).toBe(true);
  });

  it('returns false once consumedAt is set', () => {
    const now = new Date('2026-01-04T00:00:00Z');
    const consumed = { ...baseInvite, consumedAt: now };
    expect(isInvitationValid(consumed, now)).toBe(false);
  });

  it('returns false after the 7-day TTL window', () => {
    const now = new Date('2026-01-10T00:00:00Z'); // 2 days past
    expect(isInvitationValid(baseInvite, now)).toBe(false);
  });
});

describe('TTL constants', () => {
  it('RESET_TOKEN_TTL_MS is exactly 1 hour', () => {
    expect(RESET_TOKEN_TTL_MS).toBe(60 * 60 * 1000);
  });

  it('INVITATION_TTL_MS is exactly 7 days', () => {
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
