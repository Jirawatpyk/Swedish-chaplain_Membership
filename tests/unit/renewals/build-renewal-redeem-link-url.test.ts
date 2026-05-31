/**
 * Unit — buildRenewalRedeemLinkUrl (go-live audit S1-P0-4 / S1-P1-1).
 *
 * Asserts the renewal email CTA helper (a) builds a correct token payload from
 * (tenant, member, cycle, now) and (b) assembles the redeem-link URL the route
 * actually serves (`/api/portal/renewal/redeem-link?t=<token>`), NOT the old
 * `/portal/account` dead-end. The HMAC sign↔verify round-trip is covered by the
 * signer/verifier suites; here we use a stub signer for a deterministic,
 * env-free contract test.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRenewalRedeemLinkUrl } from '@/modules/renewals/application/use-cases/_lib/build-renewal-redeem-link-url';
import {
  RENEWAL_LINK_TOKEN_VERSION,
  RENEWAL_LINK_TOKEN_TTL_SECONDS,
  type RenewalLinkTokenPayload,
} from '@/modules/renewals/domain/renewal-link-token';
import type { RenewalLinkTokenSigner } from '@/modules/renewals/application/ports/renewal-link-token-signer';

function stubSigner(token: string): {
  signer: RenewalLinkTokenSigner;
  sign: ReturnType<typeof vi.fn>;
} {
  const sign = vi.fn((payload: RenewalLinkTokenPayload) => ({
    token,
    payload,
    tokenSha256: new Uint8Array(32),
  }));
  return { signer: { sign }, sign };
}

describe('buildRenewalRedeemLinkUrl', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const args = {
    tenantId: 'swecham',
    memberId: '00000000-0000-4000-8000-000000000abc',
    cycleId: '11111111-1111-4111-8111-000000000def',
    now,
  };

  it('points at the redeem-link route with the signed token, not /portal/account', () => {
    const { signer } = stubSigner('TOKEN123');
    const url = buildRenewalRedeemLinkUrl(signer, 'https://swecham.zyncdata.app', args);
    expect(url).toBe(
      'https://swecham.zyncdata.app/api/portal/renewal/redeem-link?t=TOKEN123',
    );
    expect(url).not.toContain('/portal/account');
  });

  it('signs a v1 payload with tenant/member/cycle + 30-day expiry', () => {
    const { signer, sign } = stubSigner('x');
    buildRenewalRedeemLinkUrl(signer, 'https://h', args);
    const iat = Math.floor(now.getTime() / 1000);
    expect(sign).toHaveBeenCalledWith({
      v: RENEWAL_LINK_TOKEN_VERSION,
      tid: 'swecham',
      mid: args.memberId,
      cid: args.cycleId,
      iat,
      exp: iat + RENEWAL_LINK_TOKEN_TTL_SECONDS,
    });
  });

  it('url-encodes token characters that are unsafe in a query value', () => {
    const { signer } = stubSigner('a.b+c/d=');
    const url = buildRenewalRedeemLinkUrl(signer, 'https://h', args);
    expect(url).toBe('https://h/api/portal/renewal/redeem-link?t=a.b%2Bc%2Fd%3D');
  });
});
