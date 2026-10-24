/**
 * 125 — `redeemInvite` single-use guard.
 *
 * The in-tx consume is a guarded UPDATE (`consumed_at IS NULL AND
 * expires_at > now`). When it matches no row — a concurrent redemption
 * already committed, or the link expired between the pre-tx read and
 * the tx — the use case MUST abort with `link-invalid` before any user
 * row is touched, instead of relying on the unrelated `status='pending'`
 * re-read to catch the replay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Invitation } from '@/modules/auth/domain/token';
import type { UserAccount } from '@/modules/auth/domain/user';
import type { InvitationTokenId, UserId } from '@/modules/auth/domain/branded';

vi.mock('@/lib/db', () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));
vi.mock('@/lib/auth-deps', () => ({ defaultRedeemInviteDeps: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  authMetrics: { invitationRedeemed: vi.fn(), invitationRedemptionFailed: vi.fn() },
}));

import { redeemInvite } from '@/modules/auth/application/redeem-invite';
import { authMetrics } from '@/lib/metrics';

const NOW = new Date('2026-10-24T00:00:00.000Z');

const INVITATION: Invitation = {
  id: 'a'.repeat(64) as Invitation['id'],
  userId: 'user-1' as UserId,
  invitedByUserId: 'inviter-1' as UserId,
  intendedRole: 'member',
  createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  consumedAt: null,
};

const PENDING_USER: UserAccount = {
  id: 'user-1' as UserId,
  email: 'invitee@swecham.test' as UserAccount['email'],
  role: 'member',
  status: 'pending',
  createdAt: NOW,
  lastSignInAt: null,
  lastPasswordChangedAt: null,
  failedSignInCount: 0,
  lockedUntil: null,
  displayName: null,
  emailVerified: true,
  requiresPasswordReset: false,
};

function makeDeps(consumed: boolean) {
  return {
    users: {
      findByIdInTx: vi.fn(async () => PENDING_USER),
      setPasswordHashInTx: vi.fn(async () => {}),
      activateInTx: vi.fn(async () => {}),
      setDisplayNameInTx: vi.fn(async () => {}),
    },
    tokens: {
      findInvitationById: vi.fn(async () => INVITATION),
      markInvitationConsumedInTx: vi.fn(async () => consumed),
    },
    sessions: { createInTx: vi.fn(async () => ({ id: 'sess-1' })) },
    audit: { append: vi.fn(async () => {}), appendInTx: vi.fn(async () => {}) },
    hasher: { hash: vi.fn(async () => 'hashed') },
    limiter: { check: vi.fn(async () => ({ success: true })) },
    checkPolicy: vi.fn(async () => ({ ok: true as const })),
    now: () => NOW,
  };
}

const INPUT = {
  token: 'a'.repeat(64) as InvitationTokenId,
  password: 'Str0ng-P@ss-2026!',
  sourceIp: '203.0.113.5',
  requestId: 'req-125-redeem',
};

describe('redeemInvite — guarded single-use consume (125)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('redeems when the guarded consume matches the live invitation row', async () => {
    const deps = makeDeps(true);
    const res = await redeemInvite(INPUT, deps as unknown as Parameters<typeof redeemInvite>[1]);
    expect(res.ok).toBe(true);
  });

  it('aborts with link-invalid and touches no user row when the consume matches nothing', async () => {
    const deps = makeDeps(false);
    const res = await redeemInvite(INPUT, deps as unknown as Parameters<typeof redeemInvite>[1]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ code: 'link-invalid', reason: 'used' });
    expect(deps.users.findByIdInTx).not.toHaveBeenCalled();
    expect(deps.users.setPasswordHashInTx).not.toHaveBeenCalled();
    expect(deps.sessions.createInTx).not.toHaveBeenCalled();
    expect(authMetrics.invitationRedeemed).not.toHaveBeenCalled();
  });
});
