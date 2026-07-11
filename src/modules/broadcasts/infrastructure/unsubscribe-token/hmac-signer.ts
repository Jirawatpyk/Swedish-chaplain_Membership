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
 * Token shape carries `tenantId + broadcastId + <encrypted email> + lang`
 * so the verifier can return the email + locale without a DB lookup, while
 * keeping the recipient's plaintext email OUT of the URL.
 *
 * Bug #8 fix (2026-07-10): the email is stored as `emlEnc` — an
 * AES-256-GCM ciphertext keyed from `UNSUBSCRIBE_TOKEN_SECRET` (domain-
 * separated from the HMAC use of the same secret) — NOT as plaintext.
 * A reader of a CDN/proxy/mail-scanner access log can no longer base64url-
 * decode the token to recover the recipient's email (PDPA §32 / GDPR
 * Art. 5(1)(c) data minimisation; privacy checklist CHK024). The HMAC
 * still defeats forgery/tampering; the AES key stays server-side, so the
 * token is self-contained (no DB lookup, so no dependency on a delivery
 * row existing at unsubscribe time) yet opaque to log readers. Legacy
 * `v1` tokens that carry a plaintext `eml` claim (issued before this fix)
 * remain honoured — unsubscribe links are valid forever (FR-030) so we
 * MUST NOT break already-delivered emails.
 *
 * Pure Infrastructure — only `node:crypto` + `@/lib/env` imports. No
 * framework / ORM / Application-port imports.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import { unsafeBrandTenantSlug } from '@/modules/tenants';
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
  /**
   * Legacy plaintext email claim — issued by tokens created before the
   * bug #8 fix. Still honoured on verify (tokens are valid forever) but
   * NEVER written by new `sign()` calls.
   */
  readonly eml?: string;
  /**
   * AES-256-GCM(email) — base64url(iv[12] ‖ authTag[16] ‖ ciphertext).
   * The email is opaque to anyone without `UNSUBSCRIBE_TOKEN_SECRET`.
   */
  readonly emlEnc?: string;
  readonly lang?: 'en' | 'th' | 'sv';
  readonly iat: number;
}

// --- Email encryption (bug #8) --------------------------------------------
// AES-256-GCM keyed by a SHA-256 digest of the token secret with a fixed
// domain-separation label, so the encryption key is independent of the raw
// HMAC key derived from the same secret. IV is random per token (the token
// is minted once per (recipient, broadcast) so determinism is not required).
const EMAIL_ENC_IV_BYTES = 12;
const EMAIL_ENC_TAG_BYTES = 16;

function emailEncKey(): Buffer {
  return createHash('sha256')
    .update(`unsub-email-enc:v1:${env.broadcasts.unsubscribeTokenSecret}`)
    .digest();
}

function encryptEmail(emailLower: string): string {
  const iv = randomBytes(EMAIL_ENC_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', emailEncKey(), iv);
  const ct = Buffer.concat([cipher.update(emailLower, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return base64urlEncode(Buffer.concat([iv, tag, ct]));
}

function decryptEmail(encoded: string): string | null {
  const buf = base64urlDecode(encoded);
  if (buf === null || buf.length <= EMAIL_ENC_IV_BYTES + EMAIL_ENC_TAG_BYTES) {
    return null;
  }
  const iv = buf.subarray(0, EMAIL_ENC_IV_BYTES);
  const tag = buf.subarray(
    EMAIL_ENC_IV_BYTES,
    EMAIL_ENC_IV_BYTES + EMAIL_ENC_TAG_BYTES,
  );
  const ct = buf.subarray(EMAIL_ENC_IV_BYTES + EMAIL_ENC_TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', emailEncKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
      'utf8',
    );
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
      emlEnc: encryptEmail(payload.emailLower),
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
    // Bug #8: prefer the encrypted `emlEnc` claim; fall back to a legacy
    // plaintext `eml` claim for tokens minted before the fix (still valid
    // forever per FR-030). A tampered/wrong-key ciphertext returns null →
    // treated as a missing email (fail closed).
    let emailPlain: string | null = null;
    if (typeof r.emlEnc === 'string' && r.emlEnc.length > 0) {
      emailPlain = decryptEmail(r.emlEnc);
    } else if (typeof r.eml === 'string' && r.eml.length > 0) {
      emailPlain = r.eml;
    }
    if (emailPlain === null || emailPlain.length === 0) {
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
      emailLower: unsafeBrandEmailLower(emailPlain.toLowerCase()),
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
/**
 * R7 staff-review MED-S4 fix — branded `UnverifiedTenantSlug` makes
 * accidental trusted use a TypeScript error. The `peek*` family is
 * the narrowest possible RLS-bypass window (pre-HMAC payload reads).
 * Returning the same brand as the verified output (`TenantSlug`)
 * silently allowed callers to mix verified and unverified slugs at
 * the type level. Branding the return forces a deliberate cast at
 * the call site (`peeked as TenantSlug`) which acts as a code review
 * marker for "I am binding RLS with an unverified tenant identity
 * because I will verify HMAC immediately afterwards".
 *
 * The downstream `unsubscribeTokenSigner.verify()` returns the
 * verified `TenantSlug`. The unsubscribe page and the
 * `unsubscribe-recipient` use-case implement the
 * peek → bind RLS → verify → defence-in-depth tenant_id_mismatch
 * pattern; this brand documents that contract at the type level.
 */
declare const UnverifiedTenantSlugBrand: unique symbol;
export type UnverifiedTenantSlug = string & {
  readonly [UnverifiedTenantSlugBrand]: true;
};

export function peekTokenTenantId(token: string): UnverifiedTenantSlug | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, b64Payload] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return null;
  const r = parsePayloadSegment(b64Payload);
  if (r === null) return null;
  return typeof r.tid === 'string' && r.tid.length > 0
    ? (r.tid as UnverifiedTenantSlug)
    : null;
}

/**
 * Pre-verify peek for the optional `lang` claim. Mirrors
 * `peekTokenTenantId` — used by the unsubscribe page's `generateMetadata`
 * to localise the `<title>` tag without paying for a full HMAC verify.
 *
 * Same security constraints as peekTokenTenantId: NEVER trust the value
 * for any decision other than UI-only locale selection (already public-
 * facing copy). The HMAC verify pass that follows binds tenant + email +
 * broadcast atomically; an attacker forging `lang` only changes the
 * rendered `<title>` of their own request.
 */
export function peekTokenLang(token: string): 'en' | 'th' | 'sv' | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [version, b64Payload] = parts as [string, string, string];
  if (version !== TOKEN_VERSION) return null;
  const r = parsePayloadSegment(b64Payload);
  if (r === null) return null;
  const lang = r.lang;
  return lang === 'en' || lang === 'th' || lang === 'sv' ? lang : null;
}
