/**
 * code-review #9 — enable/disable-user return the MUTATED state directly.
 *
 * Pre-fix (W2-01) these did a second `findById` after the mutation + audit had
 * already committed and returned 404 on a null re-read — a self-contradicting
 * response (the `account_reenabled`/`account_disabled` audit row says it
 * happened, the API says not-found). Since an active/disabled user is never
 * hard-deleted (the repo only deletes `pending` rows), that branch was a
 * should-never-happen. The fix returns the constructed mutated state (mirroring
 * the repo SET) on success and drops the re-read entirely.
 *
 * These tests lock: (1) success returns `ok` with the new status + cleared
 * lockout (enable), (2) NO second findById round-trip, (3) the genuine
 * pre-mutation not-found / state guards still error.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Prevent the default deps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({
  defaultEnableUserDeps: {},
  defaultDisableUserDeps: {},
}));

import { enableUser } from '@/modules/auth/application/enable-user';
import type { EnableUserDeps } from '@/modules/auth/application/enable-user';
import { disableUser } from '@/modules/auth/application/disable-user';
import type { DisableUserDeps } from '@/modules/auth/application/disable-user';
import { asUserId, asEmailAddress } from '@/modules/auth/domain/branded';

const NOW = new Date('2026-06-03T10:00:00Z');
const TARGET_ID = asUserId('22222222-2222-4222-8222-222222222222');
const ACTOR_ID = asUserId('33333333-3333-4333-8333-333333333333');

function userFixture(over: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: asEmailAddress('target@swecham.test'),
    role: 'member' as const,
    status: 'disabled' as const,
    createdAt: NOW,
    lastSignInAt: null,
    lastPasswordChangedAt: null,
    // Pre-mutation lockout state — enable must clear it in the returned object.
    failedSignInCount: 4,
    lockedUntil: new Date('2026-06-03T11:00:00Z'),
    displayName: 'Target',
    emailVerified: true,
    requiresPasswordReset: false,
    ...over,
  };
}

const input = {
  targetUserId: TARGET_ID,
  actorUserId: ACTOR_ID,
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

describe('enableUser — returns mutated state without a re-read (code-review #9)', () => {
  it('success → ok with status active + cleared failed-count/lockout, findById called ONCE', async () => {
    const findById = vi.fn().mockResolvedValue(userFixture({ status: 'disabled' }));
    const enable = vi.fn().mockResolvedValue(undefined);
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = {
      users: { findById, enable } as unknown as EnableUserDeps['users'],
      audit: { append } as unknown as EnableUserDeps['audit'],
    } as EnableUserDeps;

    const r = await enableUser(input, deps);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.user.status).toBe('active');
      expect(r.value.user.failedSignInCount).toBe(0);
      expect(r.value.user.lockedUntil).toBeNull();
      // identity fields preserved from the pre-mutation read
      expect(r.value.user.email).toBe('target@swecham.test');
    }
    expect(enable).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledOnce();
    // The fix removed the post-mutation re-read — exactly one findById.
    expect(findById).toHaveBeenCalledOnce();
  });

  it('not-disabled target → not-disabled error, no mutation', async () => {
    const findById = vi.fn().mockResolvedValue(userFixture({ status: 'active' }));
    const enable = vi.fn();
    const deps = {
      users: { findById, enable } as unknown as EnableUserDeps['users'],
      audit: { append: vi.fn() } as unknown as EnableUserDeps['audit'],
    } as EnableUserDeps;

    const r = await enableUser(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-disabled');
    expect(enable).not.toHaveBeenCalled();
  });
});

describe('disableUser — returns mutated state without a re-read (code-review #9)', () => {
  it('success → ok with status disabled + sessionsRevoked, findById called ONCE', async () => {
    const findById = vi.fn().mockResolvedValue(userFixture({ status: 'active' }));
    const disable = vi.fn().mockResolvedValue(undefined);
    const deleteByUserId = vi.fn().mockResolvedValue(2);
    const append = vi.fn().mockResolvedValue(undefined);
    const deps = {
      users: {
        findById,
        disable,
        // member role → last-admin guard is skipped
        countActiveAdmins: vi.fn().mockResolvedValue(5),
      } as unknown as DisableUserDeps['users'],
      sessions: { deleteByUserId } as unknown as DisableUserDeps['sessions'],
      audit: { append } as unknown as DisableUserDeps['audit'],
      now: () => NOW,
    } as DisableUserDeps;

    const r = await disableUser(input, deps);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.user.status).toBe('disabled');
      expect(r.value.sessionsRevoked).toBe(2);
      expect(r.value.user.email).toBe('target@swecham.test');
    }
    expect(disable).toHaveBeenCalledOnce();
    expect(findById).toHaveBeenCalledOnce();
    // Finding 4 — sessionsRevoked=2 must emit BOTH account_disabled AND
    // concurrent_sessions_revoked. Lock the second emit so a refactor dropping
    // it can't ship green.
    expect(append).toHaveBeenCalledTimes(2);
    expect(
      append.mock.calls.some(
        (c) =>
          (c[0] as { eventType?: string }).eventType ===
          'concurrent_sessions_revoked',
      ),
    ).toBe(true);
  });

  it('already-disabled target → already-disabled error, no mutation', async () => {
    const findById = vi.fn().mockResolvedValue(userFixture({ status: 'disabled' }));
    const disable = vi.fn();
    const deps = {
      users: {
        findById,
        disable,
        countActiveAdmins: vi.fn().mockResolvedValue(5),
      } as unknown as DisableUserDeps['users'],
      sessions: { deleteByUserId: vi.fn() } as unknown as DisableUserDeps['sessions'],
      audit: { append: vi.fn() } as unknown as DisableUserDeps['audit'],
      now: () => NOW,
    } as DisableUserDeps;

    const r = await disableUser(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('already-disabled');
    expect(disable).not.toHaveBeenCalled();
  });
});
