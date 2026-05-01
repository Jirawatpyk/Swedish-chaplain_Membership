/**
 * T140 — HMAC unsubscribe-token signer (F7 US4).
 *
 * Signs one-click unsubscribe tokens for the public `/unsubscribe/[token]`
 * route. HMAC-SHA256 over a base64url-encoded JSON payload using
 * `UNSUBSCRIBE_TOKEN_SECRET`. Mirrors F1 session-cookie signing pattern
 * (Lucia v3 guide).
 *
 *   token = `v1.${base64url(JSON.stringify(payload))}.${base64url(HMAC_SHA256(secret, b64Payload))}`
 *
 * Tokens are valid forever (FR-030 + GDPR Art. 21 right-to-object). The
 * `iat` field is informational only — used for log forensics, not expiry.
 *
 * Token shape carries `tenantId + broadcastId + emailLower + lang` so the
 * verifier can return the email + locale without a DB lookup. The URL is
 * private to the recipient (per-recipient body); the HMAC defeats forgery
 * + tampering.
 *
 * Pure Infrastructure — only `node:crypto` + `@/lib/env` imports. No
 * framework / ORM / Application-port imports.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import { unsafeBrandTenantSlug, type TenantSlug } from '@/modules/tenants';
import {
  asBroadcastId,
  type BroadcastId,
} from '../../domain/broadcast';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';
import type {
  TokenVerifyError,
  UnsubscribeTokenPayload,
  UnsubscribeTokenPort,
} from '../../application/ports/unsubscribe-token-port';

const TOKEN_VERSION = 'v1' as const;

interface RawPayload {
  readonly v: 1;
  readonly tid: string;
  readonly bid: string;
  readonly eml: string;
  readonly lang?: 'en' | 'th' | 'sv';
  readonly iat: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

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

function hmac(b64Payload: string): string {
  return base64urlEncode(
    createHmac('sha256', env.broadcasts.unsubscribeTokenSecret)
      .update(b64Payload)
      .digest(),
  );
}

function isLang(v: unknown): v is 'en' | 'th' | 'sv' {
  return v === 'en' || v === 'th' || v === 'sv';
}

/**
 * Decode + JSON-parse the b64url payload segment. Returns `null` on any
 * structural failure. Shared by `verify()` and `peekTokenTenantId()` so the
 * two parsers cannot diverge — the defence-in-depth `payload.tenantId !==
 * tenantId` check in the route uses that invariant.
 */
function parsePayloadSegment(b64Payload: string): Record<string, unknown> | null {
  const buf = base64urlDecode(b64Payload);
  if (buf === null) return null;
  try {
    const raw = JSON.parse(buf.toString('utf-8'));
    return typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const unsubscribeTokenSigner: UnsubscribeTokenPort = {
  sign(payload: UnsubscribeTokenPayload): string {
    const raw: RawPayload = {
      v: 1,
      tid: payload.tenantId,
      bid: payload.broadcastId,
      eml: payload.emailLower,
      ...(payload.lang ? { lang: payload.lang } : {}),
      iat: Math.floor(Date.now() / 1000),
    };
    const b64Payload = base64urlEncode(Buffer.from(JSON.stringify(raw)));
    const mac = hmac(b64Payload);
    return `${TOKEN_VERSION}.${b64Payload}.${mac}`;
  },

  verify(token: string): Result<UnsubscribeTokenPayload, TokenVerifyError> {
    if (typeof token !== 'string' || token.length === 0) {
      return err({ kind: 'token.malformed', raw: '' });
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return err({ kind: 'token.malformed', raw: token });
    }
    const [version, b64Payload, providedMac] = parts as [string, string, string];

    if (version !== TOKEN_VERSION) {
      return err({ kind: 'token.unsupported_version', version });
    }

    const expectedMac = hmac(b64Payload);

    // Length-equality MUST hold before timingSafeEqual (it throws on
    // mismatched lengths, which would itself leak length via timing).
    if (expectedMac.length !== providedMac.length) {
      return err({ kind: 'token.bad_signature' });
    }
    if (!timingSafeEqual(Buffer.from(expectedMac), Buffer.from(providedMac))) {
      return err({ kind: 'token.bad_signature' });
    }

    // HMAC valid → safe to parse payload (constant-time was performed
    // before any parse work).
    const r = parsePayloadSegment(b64Payload);
    if (r === null) {
      logger.warn({}, 'unsubscribe_token_payload_not_parseable');
      return err({ kind: 'token.invalid_payload', reason: 'not_json' });
    }
    if (r.v !== 1) {
      return err({ kind: 'token.invalid_payload', reason: 'bad_version' });
    }
    if (typeof r.tid !== 'string' || r.tid.length === 0) {
      return err({ kind: 'token.invalid_payload', reason: 'missing_tid' });
    }
    if (typeof r.bid !== 'string' || r.bid.length === 0) {
      return err({ kind: 'token.invalid_payload', reason: 'missing_bid' });
    }
    if (typeof r.eml !== 'string' || r.eml.length === 0) {
      return err({ kind: 'token.invalid_payload', reason: 'missing_eml' });
    }
    const bidParsed = asBroadcastId(r.bid as string);
    const lang = r.lang;
    if (lang !== undefined && !isLang(lang)) {
      return err({ kind: 'token.invalid_payload', reason: 'bad_lang' });
    }

    const result: UnsubscribeTokenPayload = {
      tenantId: unsafeBrandTenantSlug(r.tid as string),
      broadcastId: bidParsed as BroadcastId,
      emailLower: unsafeBrandEmailLower((r.eml as string).toLowerCase()),
      ...(lang ? { lang } : {}),
    };
    return ok(result);
  },
};

/**
 * Pre-tenant resolver — parses the b64 payload WITHOUT verifying HMAC.
 * Production callers (the public `/unsubscribe/[token]` route) use this
 * to extract `tenantId` BEFORE binding the RLS context, then call
 * `verify()` under the resolved tenant. Returns `null` on any structural
 * failure — caller MUST treat null as an invalid token (audit + render
 * fallback page).
 *
 * Security note: this function is the narrowest possible RLS-bypass
 * window — it reads only the unsigned `tid` claim, never trusts other
 * payload fields, and is followed immediately by an HMAC `verify()` pass
 * under the bound tenant. NEVER expose other payload fields from this
 * function and NEVER use the returned tid for anything other than RLS
 * binding.
 */
export function peekTokenTenantId(token: string): TenantSlug | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, b64Payload] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return null;
  const r = parsePayloadSegment(b64Payload);
  if (r === null) return null;
  return typeof r.tid === 'string' && r.tid.length > 0
    ? unsafeBrandTenantSlug(r.tid)
    : null;
}
