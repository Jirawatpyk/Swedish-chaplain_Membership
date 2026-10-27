/**
 * 134-s4 — an ERASED login's role cannot be changed.
 *
 * `eraseUser` leaves the row `disabled` with the sentinel email, and
 * enableUser already refuses it (133). /admin/users stopped offering Change
 * role on an erased row in 134-s3; this is the server half, so the route and
 * the list agree. Refused as `not-found`, the same enumeration-safe answer as
 * a missing row, before any write, session revoke or audit row.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth-deps', () => ({ defaultChangeRoleDeps: {} }));

import { changeRole, type ChangeRoleDeps } from '@/modules/auth/application/change-role';
import { asEmailAddress, asUserId } from '@/modules/auth/domain/branded';
import { erasedUserEmail } from '@/modules/auth/domain/erased-user-email';

const TARGET_ID = asUserId('44444444-4444-4444-8444-444444444444');

function depsFor(email: string) {
  const setRole = vi.fn().mockResolvedValue(undefined);
  const deleteByUserId = vi.fn().mockResolvedValue(0);
  const append = vi.fn().mockResolvedValue(undefined);
  const row = {
    id: TARGET_ID,
    email: asEmailAddress(email),
    role: 'manager',
    status: 'disabled',
    displayName: '[erased]',
  };
  const deps = {
    users: {
      findById: vi.fn().mockResolvedValue(row),
      countActiveAdministrators: vi.fn().mockResolvedValue(5),
      setRole,
    },
    sessions: { deleteByUserId },
    audit: { append },
  };
  return { deps: deps as unknown as ChangeRoleDeps, setRole, deleteByUserId, append };
}

const input = {
  targetUserId: TARGET_ID,
  newRole: 'admin' as const,
  actorUserId: asUserId('55555555-5555-4555-8555-555555555555'),
  sourceIp: '203.0.113.9',
  requestId: 'req-134-s4',
};

describe('changeRole — an erased login keeps its role (134-s4)', () => {
  it('refuses the erasure sentinel as not-found and writes nothing', async () => {
    const { deps, setRole, deleteByUserId, append } = depsFor(erasedUserEmail(TARGET_ID));
    const r = await changeRole(input, deps);
    expect(r).toEqual({ ok: false, error: { code: 'not-found' } });
    expect(setRole).not.toHaveBeenCalled();
    expect(deleteByUserId).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it('still changes the role of an ordinary disabled login', async () => {
    const { deps, setRole } = depsFor('off.staff@swecham.test');
    const r = await changeRole(input, deps);
    expect(r.ok).toBe(true);
    expect(setRole).toHaveBeenCalledWith(TARGET_ID, 'admin');
  });
});
