import { describe, it, expect } from 'vitest';
import { derivePortalState } from '@/modules/members/domain/portal-state';

const NOW = new Date('2026-07-23T10:00:00.000Z');
const USER = '11111111-1111-4111-8111-111111111111';

describe('derivePortalState', () => {
  it('returns not_invited when no user is linked', () => {
    expect(
      derivePortalState({ linkedUserId: null, pendingInvitation: null, now: NOW }),
    ).toBe('not_invited');
  });

  it('returns not_invited even if an invitation somehow exists without a link', () => {
    expect(
      derivePortalState({
        linkedUserId: null,
        pendingInvitation: { expiresAt: new Date('2026-07-30T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('not_invited');
  });

  it('returns active when a user is linked and no invitation is pending', () => {
    expect(
      derivePortalState({ linkedUserId: USER, pendingInvitation: null, now: NOW }),
    ).toBe('active');
  });

  it('returns invited when the pending invitation is still live', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: new Date('2026-07-30T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('invited');
  });

  it('returns invite_expired when the pending invitation is past expiry', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: new Date('2026-07-20T10:00:00.000Z') },
        now: NOW,
      }),
    ).toBe('invite_expired');
  });

  it('treats expiry exactly at now as expired (matches the detail page boundary)', () => {
    expect(
      derivePortalState({
        linkedUserId: USER,
        pendingInvitation: { expiresAt: NOW },
        now: NOW,
      }),
    ).toBe('invite_expired');
  });
});
