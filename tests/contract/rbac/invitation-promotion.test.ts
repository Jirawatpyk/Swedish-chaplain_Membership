/**
 * T044 — invitation coherence across Migration C promotion (016 PR 3, US1).
 *
 * Migration C promotes human admins AND their OPEN invitations in the SAME
 * deploy (design §5, two UPDATEs). This test pins WHY the second UPDATE exists:
 * `redeemInvite` verifies `user.role === invitation.intendedRole` as a tamper
 * check, so the two rows MUST move together or a mid-cutover redemption fails.
 *
 * It drives the REAL `redeemInvite` use case (fakes only for the repos/infra it
 * calls out to) across the three role-pairings Migration C could leave behind:
 *
 *   - coherent post-C  (user super_admin + invitation super_admin) → REDEEMS
 *   - user-only promoted (user super_admin + invitation admin)      → tamper → link-invalid
 *   - invitation-only    (user admin + invitation super_admin)      → tamper → link-invalid
 *
 * The first case is the guarantee (both promoted → still works); the other two
 * are the failure modes the coupled promotion prevents — a regression guard on
 * Migration C's design, complementary to the SQL-level rehearsal in
 * tests/integration/auth/migration-c-promotion.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@/modules/auth/domain/role';
import type { Invitation } from '@/modules/auth/domain/token';
import type { UserAccount } from '@/modules/auth/domain/user';
import type { InvitationTokenId, UserId } from '@/modules/auth/domain/branded';

// db.transaction just runs the callback with a throwaway tx — the repo fakes
// ignore it. Keeps the use case's real control flow without a live connection.
vi.mock('@/lib/db', () => ({
  db: { transaction: async (fn: (tx: unknown) => unknown) => fn({}) },
}));
// The use case imports its default deps object at module load; stub it so the
// import never drags the argon2/Upstash/repo singletons into the test graph.
vi.mock('@/lib/auth-deps', () => ({ defaultRedeemInviteDeps: {} }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  authMetrics: { invitationRedeemed: vi.fn(), invitationRedemptionFailed: vi.fn() },
}));

const NOW = new Date('2026-08-11T00:00:00.000Z');
const FUTURE = new Date('2026-08-14T00:00:00.000Z');

function invitation(intendedRole: Role): Invitation {
  return {
    id: 'a'.repeat(64) as Invitation['id'],
    userId: 'user-1' as UserId,
    invitedByUserId: 'inviter-1' as UserId,
    intendedRole,
    createdAt: NOW,
    expiresAt: FUTURE,
    consumedAt: null,
  };
}

function pendingUser(role: Role): UserAccount {
  return {
    id: 'user-1' as UserId,
    email: 'invitee@swecham.se' as UserAccount['email'],
    role,
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
}

async function runRedeem(userRole: Role, invitationRole: Role) {
  const { redeemInvite } = await import('@/modules/auth/application/redeem-invite');
  const deps = {
    users: {
      findByIdInTx: async () => pendingUser(userRole),
      setPasswordHashInTx: async () => {},
      activateInTx: async () => {},
      setDisplayNameInTx: async () => {},
    },
    tokens: {
      findInvitationById: async () => invitation(invitationRole),
      markInvitationConsumedInTx: async () => {},
    },
    sessions: { createInTx: async () => ({ id: 'sess-1' }) },
    audit: { append: async () => {}, appendInTx: async () => {} },
    hasher: { hash: async () => 'hashed' },
    limiter: { check: async () => ({ success: true }) },
    checkPolicy: async () => ({ ok: true as const }),
    now: () => NOW,
  } as unknown as Parameters<typeof redeemInvite>[1];

  return redeemInvite(
    {
      token: 'a'.repeat(64) as InvitationTokenId,
      password: 'Str0ng-P@ss-2026!',
      sourceIp: '203.0.113.5',
      requestId: 'test-req-t044',
    },
    deps,
  );
}

describe('T044 invitation coherence across Migration C promotion', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('coherent post-C pair (user + invitation both super_admin) redeems', async () => {
    const res = await runRedeem('super_admin', 'super_admin');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.user.role).toBe('super_admin');
  });

  it('user promoted but invitation NOT (super_admin vs admin) fails the tamper check', async () => {
    const res = await runRedeem('super_admin', 'admin');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('link-invalid');
  });

  it('invitation promoted but user NOT (admin vs super_admin) fails the tamper check', async () => {
    const res = await runRedeem('admin', 'super_admin');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('link-invalid');
  });

  it('control: an unpromoted admin pair still redeems (pre-cutover)', async () => {
    const res = await runRedeem('admin', 'admin');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.user.role).toBe('admin');
  });
});
