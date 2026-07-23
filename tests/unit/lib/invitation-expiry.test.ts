/**
 * `isInvitationExpired` — the SINGLE expiry-boundary implementation shared by
 * the directory portal badge (`derivePortalState`) and the member detail page's
 * pending-invitation mapping. This test pins the boundary for BOTH surfaces:
 * because they call this one helper, there is no second copy to drift, and a
 * `<=` → `<` regression here fails here (and is caught by every consumer's
 * behaviour). See src/lib/invitation-expiry.ts.
 */
import { describe, it, expect } from 'vitest';
import { isInvitationExpired } from '@/lib/invitation-expiry';

const NOW = new Date('2026-07-23T10:00:00.000Z');

describe('isInvitationExpired', () => {
  it('is false when the invitation expires strictly after now', () => {
    expect(isInvitationExpired(new Date('2026-07-23T10:00:00.001Z'), NOW)).toBe(false);
    expect(isInvitationExpired(new Date('2026-07-30T10:00:00.000Z'), NOW)).toBe(false);
  });

  it('is true when the invitation expires strictly before now', () => {
    expect(isInvitationExpired(new Date('2026-07-23T09:59:59.999Z'), NOW)).toBe(true);
    expect(isInvitationExpired(new Date('2026-07-20T10:00:00.000Z'), NOW)).toBe(true);
  });

  it('treats expiry exactly at now as EXPIRED (the `<=` boundary both surfaces depend on)', () => {
    expect(isInvitationExpired(new Date(NOW), NOW)).toBe(true);
  });
});
