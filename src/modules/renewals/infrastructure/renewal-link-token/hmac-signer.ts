/**
 * F8 Phase 2 Wave G · T054 · part 1 — HMAC signer for renewal-link tokens.
 *
 * Implements `RenewalLinkTokenSigner` (Wave E port T048). HMAC-SHA256
 * over a base64url-encoded JSON payload using
 * `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (R1 + R16 — sibling verifier
 * adapter handles dual-key fallback).
 *
 * Wire format: `v1.<base64url-payload>.<base64url-hmac>` — compact for
 * URL-path inclusion. Mirror of F7 unsubscribe-token-signer pattern,
 * adapted to F8's renewal-link payload shape (tid/mid/cid/iat/exp).
 *
 * Pure Infrastructure — only `node:crypto` + `@/lib/env` imports. No
 * framework / ORM / Application-port direct imports.
 */
import { createHash, createHmac } from 'node:crypto';
import { env } from '@/lib/env';
import type {
  RenewalLinkTokenPayload,
  RenewalLinkTokenVersion,
} from '../../domain/renewal-link-token';
import { RENEWAL_LINK_TOKEN_VERSION } from '../../domain/renewal-link-token';
import type {
  RenewalLinkTokenSigner,
  SignedRenewalLinkToken,
} from '../../application/ports/renewal-link-token-signer';

const TOKEN_VERSION_TAG = 'v1' as const;

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function hmacWithSecret(secret: string, b64Payload: string): string {
  return base64urlEncode(
    createHmac('sha256', secret).update(b64Payload).digest(),
  );
}

interface RawWirePayload {
  readonly v: RenewalLinkTokenVersion;
  readonly tid: string;
  readonly mid: string;
  readonly cid: string;
  readonly iat: number;
  readonly exp: number;
}

export const renewalLinkTokenSigner: RenewalLinkTokenSigner = {
  sign(payload: RenewalLinkTokenPayload): SignedRenewalLinkToken {
    const raw: RawWirePayload = {
      v: RENEWAL_LINK_TOKEN_VERSION,
      tid: payload.tid,
      mid: payload.mid,
      cid: payload.cid,
      iat: payload.iat,
      exp: payload.exp,
    };
    const b64Payload = base64urlEncode(Buffer.from(JSON.stringify(raw)));
    const mac = hmacWithSecret(
      env.renewals.linkTokenSecretPrimary,
      b64Payload,
    );
    const token = `${TOKEN_VERSION_TAG}.${b64Payload}.${mac}`;
    const tokenSha256 = createHash('sha256').update(token).digest();
    return {
      token,
      payload,
      tokenSha256: new Uint8Array(tokenSha256),
    };
  },
};
