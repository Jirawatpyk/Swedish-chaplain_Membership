/**
 * 133 (#665 PDPA review, M-1) — an ERASED login can never be re-enabled.
 *
 * `eraseUser` anonymises the row (sentinel `erased+{id}@erased.invalid`, no
 * password) and leaves it `disabled`. The revert-email sink refuses a
 * `disabled` user, so re-enabling an erased login was the step that let a
 * surviving cross-tenant revert token write the erased real email back onto
 * `users.email`. Re-enabling one also makes no sense (no password, no email).
 * Refused as `not-found`, the same enumeration-safe answer as a missing row.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-deps', () => ({
  defaultEnableUserDeps: {},
  defaultDisableUserDeps: {},
}));

import { enableUser } from '@/modules/auth/application/enable-user';
import type { EnableUserDeps } from '@/modules/auth/application/enable-user';
import { asUserId, asEmailAddress } from '@/modules/auth/domain/branded';

const TARGET_ID = asUserId('22222222-2222-4222-8222-222222222222');

function depsFor(email: string) {
  const enable = vi.fn();
  const append = vi.fn();
  const deps = {
    users: {
      findById: vi.fn().mockResolvedValue({
        id: TARGET_ID,
        email: asEmailAddress(email),
        role: 'member',
        status: 'disabled',
        createdAt: new Date('2026-06-03T10:00:00Z'),
        lastSignInAt: null,
        lastPasswordChangedAt: null,
        failedSignInCount: 0,
        lockedUntil: null,
        displayName: '[erased]',
        emailVerified: false,
        requiresPasswordReset: false,
      }),
      enable,
    },
    audit: { append },
  };
  return { deps: deps as unknown as EnableUserDeps, enable, append };
}

const input = {
  targetUserId: TARGET_ID,
  actorUserId: asUserId('33333333-3333-4333-8333-333333333333'),
  sourceIp: '203.0.113.5',
  requestId: 'req-133',
};

describe('enableUser — an erased login stays disabled (133)', () => {
  it('refuses the erasure sentinel as not-found and writes nothing', async () => {
    const { deps, enable, append } = depsFor(`erased+${TARGET_ID}@erased.invalid`);
    const r = await enableUser(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
    expect(enable).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('still re-enables an ordinary disabled login', async () => {
    const { deps, enable } = depsFor('member@swecham.test');
    const r = await enableUser(input, deps);
    expect(r.ok).toBe(true);
    expect(enable).toHaveBeenCalledOnce();
  });
});
