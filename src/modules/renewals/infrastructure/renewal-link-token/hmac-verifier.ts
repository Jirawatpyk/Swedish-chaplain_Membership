/**
 * F8 Phase 2 Wave G · T054 · part 2 — HMAC verifier with R16 dual-key
 * rotation.
 *
 * Implements `RenewalLinkTokenVerifier` (Wave E port T048). Verifies
 * first against `RENEWAL_LINK_TOKEN_SECRET_PRIMARY`; on signature
 * mismatch AND `_FALLBACK` is configured, retries against fallback.
 * Then runs structural + tenant + expiry checks via the Domain
 * `parsePayload` helper.
 *
 * `verifiedWith: 'primary' | 'fallback'` propagates to the result so
 * callers can emit observability events during rotation windows.
 *
 * Pure Infrastructure — only `node:crypto` + `@/lib/env` + Domain
 * helpers + Application port imports. No framework / ORM imports.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { err, ok } from '@/lib/result';
import { env } from '@/lib/env';
import { parsePayload } from '../../domain/renewal-link-token';
import type {
  RenewalLinkTokenVerifier,
  VerifyTokenContext,
} from '../../application/ports/renewal-link-token-verifier';

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
}

/**
 * Compare two HMAC results in constant time at the BYTE level.
 *
 * Round-4 deep-review fix — the previous string-level implementation
 * short-circuited on `a.length !== b.length` BEFORE running
 * `timingSafeEqual`, which is itself constant-time only across same-
 * length inputs. While HMAC-SHA256 base64url output is always 43
 * chars, the early-return path still exposed a measurable timing
 * difference for forged tokens whose MAC fragment was padded to a
 * non-43-char length: the rejection happened without any Buffer
 * allocation or HMAC compare. Attackers could probe for "is my MAC
 * the right shape?" faster than for "is my MAC the right value?"
 *
 * Fix — accept raw Buffers (always 32 bytes from SHA-256), feed
 * timingSafeEqual a fixed-shape pair. If the user-supplied MAC
 * decodes to a different byte length, allocate a same-length zero
 * buffer and compare anyway so the rejection latency is independent
 * of the supplied length.
 */
function constantTimeEqualBytes(expected: Buffer, supplied: Buffer): boolean {
  if (supplied.length !== expected.length) {
    // Compare expected against a zeroed buffer of the same shape so
    // the call still runs the same number of byte ops; result is
    // discarded — the length mismatch already disqualifies the MAC.
    timingSafeEqual(expected, Buffer.alloc(expected.length));
    return false;
  }
  return timingSafeEqual(expected, supplied);
}

function hmacWithBytes(secret: string, b64Payload: string): Buffer {
  return createHmac('sha256', secret).update(b64Payload).digest();
}

export const renewalLinkTokenVerifier: RenewalLinkTokenVerifier = {
  verify(rawToken: string, ctx: VerifyTokenContext) {
    if (typeof rawToken !== 'string' || rawToken.length === 0) {
      return err({
        kind: 'malformed_token',
      });
    }
    const parts = rawToken.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') {
      return err({
        kind: 'malformed_token',
      });
    }
    const [, b64Payload, mac] = parts as [string, string, string];

    // Decode the user-supplied MAC up front so the comparison runs at
    // byte level. `null` (invalid base64url) is treated as a length-0
    // buffer; the constant-time compare then runs against the
    // expected 32-byte HMAC and rejects in constant latency.
    const suppliedMacBytes = base64urlDecode(mac) ?? Buffer.alloc(0);

    const primaryMacBytes = hmacWithBytes(
      env.renewals.linkTokenSecretPrimary,
      b64Payload,
    );
    let verifiedWith: 'primary' | 'fallback' | null = null;
    if (constantTimeEqualBytes(primaryMacBytes, suppliedMacBytes)) {
      verifiedWith = 'primary';
    } else if (env.renewals.linkTokenSecretFallback) {
      const fallbackMacBytes = hmacWithBytes(
        env.renewals.linkTokenSecretFallback,
        b64Payload,
      );
      if (constantTimeEqualBytes(fallbackMacBytes, suppliedMacBytes)) {
        verifiedWith = 'fallback';
      }
    }
    if (verifiedWith === null) {
      return err({
        kind: 'signature_mismatch',
      });
    }

    const payloadBytes = base64urlDecode(b64Payload);
    if (payloadBytes === null) {
      return err({
        kind: 'malformed_token',
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(payloadBytes.toString('utf-8'));
    } catch {
      return err({
        kind: 'malformed_token',
      });
    }
    if (typeof raw !== 'object' || raw === null) {
      return err({
        kind: 'malformed_token',
      });
    }

    const parsed = parsePayload(raw as Record<string, unknown>, ctx);
    if (!parsed.ok) {
      // Map Domain TokenPayloadError → Application VerifyTokenError. The
      // verifier port narrows to the 5 distinguishable wire-level kinds
      // (malformed/signature_mismatch/wrong_version/tenant_mismatch/expired);
      // Domain's malformed_iat_exp + missing_field both collapse to
      // `malformed_token` for the audit-emit path.
      const e = parsed.error;
      if (e.kind === 'wrong_version') {
        return err({ kind: 'wrong_version', raw: e.raw });
      }
      if (e.kind === 'tenant_mismatch') {
        return err({
          kind: 'tenant_mismatch',
          expectedTenantId: e.expected,
          tokenTenantId: e.got,
        });
      }
      if (e.kind === 'expired') {
        return err({ kind: 'expired', expSec: e.expSec, nowSec: e.nowSec });
      }
      // missing_field + malformed_iat_exp → malformed_token from caller's POV.
      return err({ kind: 'malformed_token' });
    }

    const tokenSha256 = createHash('sha256').update(rawToken).digest();
    return ok({
      payload: parsed.value,
      tokenSha256: new Uint8Array(tokenSha256),
      verifiedWith,
    });
  },
};
