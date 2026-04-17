import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isLocked,
  isUserStatus,
  USER_STATUSES,
  type UserAccount,
} from '@/modules/auth/domain/user';

function userFixture(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: 'uid-1' as UserAccount['id'],
    email: 'a@b.com' as UserAccount['email'],
    role: 'admin',
    status: 'active',
    createdAt: new Date('2026-01-01'),
    lastSignInAt: null,
    lastPasswordChangedAt: null,
    failedSignInCount: 0,
    lockedUntil: null,
    displayName: null,
    emailVerified: true,
    requiresPasswordReset: false,
    ...overrides,
  };
}

describe('USER_STATUSES', () => {
  it('contains exactly active, pending, disabled', () => {
    expect([...USER_STATUSES].sort()).toEqual(['active', 'disabled', 'pending']);
  });
});

describe('isUserStatus', () => {
  it('accepts valid statuses', () => {
    expect(isUserStatus('active')).toBe(true);
    expect(isUserStatus('pending')).toBe(true);
    expect(isUserStatus('disabled')).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isUserStatus('archived')).toBe(false);
    expect(isUserStatus('')).toBe(false);
    expect(isUserStatus('ACTIVE')).toBe(false);
  });
});

describe('canTransition', () => {
  it('allows pending → active', () => {
    expect(canTransition('pending', 'active')).toBe(true);
  });

  it('allows active → disabled', () => {
    expect(canTransition('active', 'disabled')).toBe(true);
  });

  it('allows disabled → active', () => {
    expect(canTransition('disabled', 'active')).toBe(true);
  });

  it('rejects same-to-same transitions', () => {
    expect(canTransition('active', 'active')).toBe(false);
    expect(canTransition('pending', 'pending')).toBe(false);
    expect(canTransition('disabled', 'disabled')).toBe(false);
  });

  it('rejects pending → disabled', () => {
    expect(canTransition('pending', 'disabled')).toBe(false);
  });

  it('rejects disabled → pending', () => {
    expect(canTransition('disabled', 'pending')).toBe(false);
  });

  it('rejects active → pending', () => {
    expect(canTransition('active', 'pending')).toBe(false);
  });
});

describe('isLocked', () => {
  const now = new Date('2026-04-15T12:00:00Z');

  it('returns false when lockedUntil is null', () => {
    const user = userFixture({ lockedUntil: null });
    expect(isLocked(user, now)).toBe(false);
  });

  it('returns false when lockedUntil is in the past', () => {
    const user = userFixture({ lockedUntil: new Date('2026-04-15T11:59:59Z') });
    expect(isLocked(user, now)).toBe(false);
  });

  it('returns true when lockedUntil is in the future', () => {
    const user = userFixture({ lockedUntil: new Date('2026-04-15T13:00:00Z') });
    const result = isLocked(user, now);
    expect(result).toBe(true);
    // Type narrowing: after the guard, lockedUntil is Date (not null)
    if (result) {
      expect(user.lockedUntil).toBeInstanceOf(Date);
    }
  });
});
