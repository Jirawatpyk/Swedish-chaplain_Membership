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

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}

function hmacWith(secret: string, b64Payload: string): string {
  return base64urlEncode(
    createHmac('sha256', secret).update(b64Payload).digest(),
  );
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

    const primaryMac = hmacWith(
      env.renewals.linkTokenSecretPrimary,
      b64Payload,
    );
    let verifiedWith: 'primary' | 'fallback' | null = null;
    if (constantTimeEqual(primaryMac, mac)) {
      verifiedWith = 'primary';
    } else if (env.renewals.linkTokenSecretFallback) {
      const fallbackMac = hmacWith(
        env.renewals.linkTokenSecretFallback,
        b64Payload,
      );
      if (constantTimeEqual(fallbackMac, mac)) {
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
